# 프로젝트 지시사항

## 목표
kimaki(https://github.com/remorses/kimaki) 소스를 개조하여 Claude Code와 Codex CLI를 동일한 방식으로 Discord에 연결하는 봇을 구현한다.

## 원칙
1. **간단하고 명확한 방법 선택** - 복잡한 추상화보다 직접적이고 이해하기 쉬운 구현
2. **계획단계와 실행단계 분리** - 계획을 완전히 마무리한 후 실행
3. **체크리스트 관리** - 태스크 단위로 진행상황 추적
4. **구현 스펙 문서화** - SPEC.md에 구현 스펙 기록, 변경시 즉시 반영
5. **트러블슈팅 기록** - TROUBLESHOOTING.md에 이슈와 해결방법 기록
6. **세부화** - 실행시 추가 구체화 필요하면 단계와 스펙을 세분화하여 기록

## 핵심 설계 결정
- kimaki는 OpenCode SDK에 강하게 결합되어 있으므로, 전체를 가져오기보다 **핵심 아키텍처만 참고**하여 새로 작성
- Discord 봇 부분은 discord.js를 사용하여 kimaki와 유사한 패턴으로 구현
- Claude Code와 Codex CLI는 **subprocess(child_process)로 실행**하고 stdin/stdout으로 통신
- 두 CLI 도구를 동일한 인터페이스로 추상화하는 **어댑터 패턴** 사용

## 기술 스택
- TypeScript + Node.js
- discord.js (Discord 봇)
- child_process (CLI 도구 실행)
- SQLite (상태 관리) - better-sqlite3 사용

## 작업 방식
- 모든 계획 변경은 SPEC.md에 반영
- 이슈 발생시 TROUBLESHOOTING.md에 기록
- 각 단계 완료시 체크리스트 업데이트
