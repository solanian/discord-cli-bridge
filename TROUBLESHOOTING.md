# 트러블슈팅 문서

이 문서는 구현 과정에서 발생한 이슈와 해결 방법을 기록합니다.
같은 실수를 반복하지 않기 위한 참고 자료입니다.

## 이슈 목록

### 1. Claude Code stream-json에 --verbose 필수
- **증상**: `claude -p --output-format stream-json "prompt"` 실행시 에러
- **원인**: Claude Code CLI는 stream-json 출력 형식 사용시 `--verbose` 플래그가 필수
- **해결**: `--verbose` 플래그 추가
- **교훈**: CLI 도구의 실제 동작을 반드시 직접 테스트하여 확인할 것. 문서만 보고 추정하지 말 것

### 4. Claude Code --dangerously-skip-permissions root 차단
- **증상**: Docker 컨테이너에서 claude exit code 1, 응답 없음
- **원인**: Claude Code CLI는 root/sudo 권한에서 `--dangerously-skip-permissions` 사용을 보안상 차단
- **해결**: 플래그 제거. `~/.claude/settings.json`의 `"defaultMode": "dontAsk"` 설정이 볼륨 마운트로 전달되므로 별도 플래그 불필요
- **교훈**: Docker root 환경에서의 CLI 동작을 반드시 컨테이너 내부에서 직접 테스트할 것

### 5. Codex JSONL 파싱 실패 - 응답 없음
- **증상**: Codex 봇이 exit code 0으로 정상 종료되지만 Discord에 응답 텍스트가 안 나옴
- **원인**: Codex의 실제 JSONL 이벤트 타입이 `item.completed`인데 파서가 `message` 타입만 처리
- **해결**: `item.completed` → `item.type === 'agent_message'`일 때 `item.text` 추출하도록 파서 수정
- **교훈**: CLI 도구의 실제 출력을 `docker exec`로 직접 확인하고 파서를 맞출 것

### 3. Codex 봇 TokenInvalid 오류
- **증상**: codex-bot 컨테이너가 `TokenInvalid` 에러로 재시작 반복
- **원인**: 제공된 Discord 봇 토큰이 유효하지 않거나 만료됨
- **해결**: Discord Developer Portal에서 토큰을 재생성하거나 올바른 토큰 확인 필요
- **교훈**: Docker compose에 토큰을 하드코딩하기 전에 로컬에서 먼저 유효성 검증할 것

### 2. better-sqlite3 네이티브 모듈 빌드
- **증상**: npm install 시 better-sqlite3 빌드 관련 경고 가능
- **원인**: 네이티브 C++ 모듈이므로 빌드 도구(python3, make, gcc) 필요
- **해결**: 현재 환경에서는 정상 빌드됨. 문제 발생시 `npm install --build-from-source` 또는 `npm rebuild`
- **교훈**: 네이티브 모듈 사용시 빌드 환경 요구사항 확인 필요

---
*형식: ## [이슈 제목] / 증상 / 원인 / 해결 / 교훈*
