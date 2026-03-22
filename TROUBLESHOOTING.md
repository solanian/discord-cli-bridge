# 트러블슈팅 문서

이 문서는 구현 과정에서 발생한 이슈와 해결 방법을 기록합니다.
같은 실수를 반복하지 않기 위한 참고 자료입니다.

## 이슈 목록

### 1. Claude Code stream-json에 --verbose 필수
- **증상**: `claude -p --output-format stream-json "prompt"` 실행시 에러
- **원인**: Claude Code CLI는 stream-json 출력 형식 사용시 `--verbose` 플래그가 필수
- **해결**: `--verbose` 플래그 추가
- **교훈**: CLI 도구의 실제 동작을 반드시 직접 테스트하여 확인할 것

### 2. Claude Code --dangerously-skip-permissions root 차단
- **증상**: Docker 컨테이너에서 claude exit code 1, 응답 없음
- **원인**: Claude Code CLI는 root/sudo 권한에서 `--dangerously-skip-permissions` 사용을 보안상 차단
- **해결**: Dockerfile에서 `USER node` (비-root)로 실행하여 해결. node 이미지의 기본 유저(UID 1000) 사용
- **교훈**: Docker root 환경에서의 CLI 동작을 반드시 컨테이너 내부에서 직접 테스트할 것

### 3. Codex JSONL 파싱 실패 - 응답 없음
- **증상**: Codex 봇이 exit code 0으로 정상 종료되지만 Discord에 응답 텍스트가 안 나옴
- **원인**: Codex의 실제 JSONL 이벤트 타입이 `item.completed`인데 파서가 `message` 타입만 처리
- **해결**: `item.completed` → `item.type === 'agent_message'`일 때 `item.text` 추출하도록 파서 수정
- **교훈**: CLI 도구의 실제 출력을 `docker exec`로 직접 확인하고 파서를 맞출 것

### 4. Codex git repo 체크 실패
- **증상**: Docker 컨테이너에서 codex exec가 아무 출력 없이 즉시 종료
- **원인**: Codex는 기본적으로 git repo 안에서만 실행됨. Docker 마운트된 디렉토리가 git repo가 아닐 수 있음
- **해결**: `--skip-git-repo-check` 플래그 추가
- **교훈**: Docker 환경과 로컬 환경의 차이를 인식하고 테스트할 것

### 5. Codex 봇 TokenInvalid 오류
- **증상**: codex-bot 컨테이너가 `TokenInvalid` 에러로 재시작 반복
- **원인**: 제공된 Discord 봇 토큰이 유효하지 않거나 만료됨
- **해결**: Discord Developer Portal에서 토큰을 재생성
- **교훈**: Docker compose에 토큰을 하드코딩하지 말고 .env 파일 사용할 것

### 6. Claude -p 모드 세션 비저장
- **증상**: `claude -p --session-id UUID`로 실행해도 세션 파일이 디스크에 저장되지 않음. resume 불가
- **원인**: `-p` (print) 모드는 기본적으로 `--no-session-persistence`가 적용됨
- **해결**: 대화 기록을 SQLite DB에 저장하고, 매 요청마다 이전 대화를 프롬프트에 포함시키는 방식으로 전환
- **교훈**: CLI의 -p 모드는 one-shot용. 세션 유지가 필요하면 DB 기반 히스토리 관리 필요

### 7. Claude --input-format stream-json 동작 불가
- **증상**: `--input-format stream-json`으로 stdin에 JSON 메시지를 보내도 아무 응답 없음
- **원인**: 이 모드는 내부 bridge(tengu) 전용. `--sdk-url`과 access token이 필요하며 일반 사용자용이 아님
- **해결**: `--input-format stream-json` 포기. tmux + `claude -p` (text 출력) + DB 히스토리 조합으로 해결
- **교훈**: CLI 옵션이 존재한다고 모두 외부 사용 가능한 것은 아님. 내부 전용 기능일 수 있음

### 8. Claude 대화형 모드 Docker 인증 실패
- **증상**: tmux에서 `claude` (대화형 모드) 실행시 OAuth 브라우저 로그인 화면 표시
- **원인**: 대화형 모드는 브라우저 OAuth 플로우를 시도. `-p` 모드만 저장된 토큰을 직접 사용
- **해결**: tmux 안에서도 `claude -p` 모드 사용. 완료 마커(`___DCB_DONE___`)로 응답 끝 감지
- **교훈**: Docker/headless 환경에서는 항상 `-p` (non-interactive) 모드 사용

### 9. tmux capture-pane 출력 파싱 실패
- **증상**: Claude가 tmux 안에서 응답했지만 Discord에 내용이 전달되지 않음
- **원인**: `extractNewContent`가 명령어 echo 줄(`claude ...`)을 찾아서 그 이후를 응답으로 추출하려 했으나, capture-pane에는 명령어 echo가 포함되지 않음
- **해결**: 파싱 로직 단순화. capture 전체 내용을 추적하고 이전 대비 증분만 추출
- **교훈**: tmux capture-pane의 실제 출력을 먼저 확인하고 파서를 설계할 것

### 10. 두 봇이 같은 채널 메시지에 반응
- **증상**: Claude 봇과 Codex 봇이 동시에 같은 메시지에 스레드를 만들려고 시도. `A thread has already been created` 에러
- **원인**: 두 봇 모두 `DEFAULT_PROJECT_DIR` 폴백으로 미등록 채널에도 반응
- **해결**: DB에 등록된 채널에서만 반응하도록 변경. 폴백 로직 제거
- **교훈**: 멀티봇 환경에서는 각 봇의 응답 범위를 명확히 격리해야 함

---
*형식: ## [이슈 제목] / 증상 / 원인 / 해결 / 교훈*
