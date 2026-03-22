# Discord CLI Bridge - 구현 스펙

## 1. 아키텍처 개요

```
Discord (사용자 메시지)
    │
    ▼
Discord Bot (discord.js)
    │
    ├── 메시지 수신 → 스레드 생성 → CLI 어댑터 호출
    │
    ▼
CLI Adapter (추상 인터페이스)
    ├── ClaudeCodeAdapter  → claude CLI subprocess
    └── CodexAdapter       → codex CLI subprocess
    │
    ▼
응답 스트리밍 → Discord 스레드에 메시지 전송
```

## 2. 핵심 컴포넌트

### 2.1 Discord Bot (`src/bot.ts`)
- discord.js 클라이언트 생성 및 이벤트 핸들링
- 채널별 프로젝트 디렉토리 매핑
- 메시지 수신 → 스레드 생성 → 세션 시작
- 슬래시 커맨드: `/session`, `/abort`, `/set-cli`, `/set-project`

### 2.2 CLI Adapter Interface (`src/adapters/base.ts`)
```typescript
interface CLIAdapter {
  name: string;
  start(options: SessionOptions): Promise<CLISession>;
}

interface CLISession {
  send(message: string): Promise<void>;
  onOutput(callback: (chunk: string) => void): void;
  onComplete(callback: () => void): void;
  onError(callback: (error: Error) => void): void;
  abort(): Promise<void>;
  isRunning(): boolean;
}

interface SessionOptions {
  prompt: string;
  workingDirectory: string;
  sessionId?: string;  // 기존 세션 resume용
}
```

### 2.3 Claude Code Adapter (`src/adapters/claude-code.ts`)
- `claude` CLI를 `--print` 모드 또는 `--output-format stream-json` 모드로 실행
- stdin으로 프롬프트 전달, stdout에서 응답 스트리밍
- `--resume` 플래그로 세션 이어하기 지원
- `--allowedTools` 등 옵션 전달

### 2.4 Codex Adapter (`src/adapters/codex.ts`)
- `codex` CLI를 실행
- `--quiet` 모드로 비대화형 실행
- stdout 파싱하여 응답 추출

### 2.5 Session Manager (`src/session-manager.ts`)
- 스레드별 활성 세션 관리
- 세션 생성/종료/abort 처리
- 메시지 큐잉 (세션 진행 중 추가 메시지)

### 2.6 Database (`src/database.ts`)
- SQLite로 상태 관리
- 테이블: channels(채널-디렉토리 매핑), sessions(스레드-세션 매핑), config(봇 설정)

### 2.7 Config (`src/config.ts`)
- 환경변수 및 설정 파일 관리
- `DISCORD_BOT_TOKEN`, `DEFAULT_CLI` (claude|codex), 프로젝트 디렉토리 등

## 3. 메시지 흐름

### 3.1 새 세션 시작
1. 사용자가 프로젝트 채널에 메시지 전송
2. 봇이 스레드 생성
3. SessionManager가 CLI 어댑터로 세션 시작
4. CLI subprocess 실행, 프롬프트 전달
5. stdout 스트리밍 → Discord 메시지로 청크 단위 전송
6. 세션 완료시 풋터 메시지 표시

### 3.2 기존 세션 이어하기
1. 사용자가 기존 스레드에 메시지 전송
2. SessionManager가 해당 스레드의 활성 세션 확인
3. 활성 세션이 있으면 메시지 큐잉
4. 세션이 idle이면 새 프롬프트로 재시작 (claude: --resume, codex: --conversation)

### 3.3 세션 중단
1. `/abort` 커맨드 또는 세션 중단 요청
2. CLI subprocess에 SIGINT 전송
3. 세션 상태 업데이트

## 4. Discord 인터랙션

### 4.1 슬래시 커맨드
| 커맨드 | 설명 |
|--------|------|
| `/session <prompt>` | 새 세션 시작 |
| `/abort` | 현재 세션 중단 |
| `/set-cli <claude\|codex>` | 채널의 기본 CLI 도구 변경 |
| `/set-project <path>` | 채널의 프로젝트 디렉토리 설정 |
| `/resume` | 이전 세션 이어하기 |

### 4.2 메시지 포맷
- 봇 응답: `▸ {응답 텍스트}` (kimaki의 ⬥와 유사)
- 도구 실행: `┣ {도구명}: {요약}`
- 풋터: `{프로젝트명} · {시간} · {CLI도구명}`

## 5. 파일 구조
```
discord-cli-bridge/
├── src/
│   ├── bot.ts              # Discord 봇 메인
│   ├── config.ts           # 설정 관리
│   ├── database.ts         # SQLite 상태 관리
│   ├── session-manager.ts  # 세션 라이프사이클
│   ├── message-handler.ts  # Discord 메시지 처리
│   ├── slash-commands.ts   # 슬래시 커맨드 등록/처리
│   ├── discord-utils.ts    # Discord 유틸리티
│   ├── logger.ts           # 로깅
│   └── adapters/
│       ├── base.ts         # 어댑터 인터페이스
│       ├── claude-code.ts  # Claude Code 어댑터
│       └── codex.ts        # Codex 어댑터
├── package.json
├── tsconfig.json
├── SPEC.md
├── INSTRUCTIONS.md
└── TROUBLESHOOTING.md
```

## 6. Claude Code 어댑터 상세

### 실행 방식
```bash
claude -p --output-format stream-json --verbose --permission-mode bypassPermissions "프롬프트"
```
- `--verbose` 필수 (stream-json은 verbose 없이 동작하지 않음)
- `--permission-mode bypassPermissions` 로 권한 프롬프트 없이 실행

### stream-json 실제 출력 형식 (검증됨)
각 줄이 JSON 객체, `type` 필드로 구분:
1. `{"type":"system","subtype":"init","session_id":"...","model":"...",...}` → 초기화 정보
2. `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}` → 어시스턴트 응답
3. `{"type":"result","subtype":"success","result":"...","duration_ms":...,"session_id":"..."}` → 최종 결과

### 세션 이어하기
```bash
claude -p --output-format stream-json --verbose -r <session-id> "새 프롬프트"
```

## 7. Codex Adapter 상세

### 실행 방식
```bash
codex exec --json --full-auto -C /path/to/project "프롬프트"
```
- `exec` 서브커맨드로 비대화형 실행
- `--json` 으로 JSONL 형식 출력
- `--full-auto` 로 자동 실행 모드
- `-C` 로 작업 디렉토리 지정

### 세션 이어하기
```bash
codex exec resume --last --json "새 프롬프트"
```

### 출력 파싱
JSONL 형식으로 각 줄이 이벤트 JSON 객체

## 8. 변경 이력
- 2026-03-21: 초기 스펙 작성
- 2026-03-21: CLI 실행 옵션 검증 결과 반영 (claude --verbose 필수, codex exec --json 지원)
