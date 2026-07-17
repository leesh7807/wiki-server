# Wiki Server

**한국어** | [English](README.en.md)

사용자 소유의 Git 기반 위키를 위한 설치형 로컬 에이전트 서버입니다.

서버는 HTTP 요청 수신, Codex 실행, 작업 생명주기, 런타임 로그,
관측 지표, 트레이 시작을 담당합니다. 설치된 위키 콘텐츠는 기본적으로
`%LOCALAPPDATA%\Wiki Server\wiki-root`에만 존재하며 독립된 Git 이력을
가집니다. 저장소가 추적하는 `wiki-template/`은 새 설치를 위한 최소 디렉터리와
운영 구조만 담습니다.

## 이 저장소를 공개하는 이유

이 저장소는 한 개인의 지식 작업 시스템에 대한 공개 기록입니다. 그 시스템을
구성하는 개념, 선택의 근거, 그리고 그 선택으로 만들어진 구현을 함께 보여주기
위해 공개합니다. 범용 위키 제품이나 지원을 약속하는 프로젝트는 아닙니다.
작성자가 작업하고 인지하는 방식에 밀접하게 맞춰져 있지만, 코드와 설계가 다른
사람에게 참고 자료가 될 수 있기를 기대합니다.

소프트웨어와 소프트웨어가 다루는 지식은 의도적으로 서로 다른 소유권과 Git
이력을 가집니다.

| 표면 | 공개 범위 | 내용 |
| --- | --- | --- |
| 이 `wiki-server` 저장소 | Public | 서버, 데스크톱 앱, 테스트, 설계 문서, 최소 초기 템플릿 |
| 운영 위키 저장소 | Private | 개인 노트, 원본 자료, 결정 기록, 축적된 지식 |
| 런타임 데이터 | 로컬 전용 | 작업 메타데이터, 원시 에이전트 이벤트, 캐시, 격리된 Codex 상태 |

서비스는 로컬 전용이며 인증 기능이 없습니다. 인증과 네트워크 통제를 별도로
추가하지 않았다면 로컬 컴퓨터 밖에 노출하지 마세요.

저장소 소유권, 공개 연동, 보안 제약은 `AGENTS.md`에 정의되어 있습니다.
일상적인 모듈 소유권과 검증 지침은 `docs/code-quality.md`에 있습니다. 코드 변경을
시작할 때는 동작별 소유 도메인과 의존성 규칙을 기록한 `docs/code-map.md`를 먼저
확인하세요.

## 실행

```powershell
npm install
npm run dev
```

개발 Node.js 버전은 `.node-version`을 통해 `24.15.0`으로 고정됩니다. fnm을
사용한다면 저장소에서 새 셸을 열거나 `fnm use`를 실행하세요.

기본값:

- 호스트: `127.0.0.1`
- 포트: `55173`(로컬 전용 기본값, 데스크톱 앱은 포트가 사용 중이면 인접한 빈
  포트를 선택하고 앱 안에서 경고합니다)
- 위키 루트: `WIKI_ROOT`; 소스 개발 환경은 마이그레이션 호환을 위해 형제
  디렉터리 `..\wiki`로 대체될 수 있습니다
- 런타임 데이터: `.cache/wiki-server` 또는 `WIKI_SERVER_DATA_DIR`
- 작업 데이터: `.cache/wiki-server/jobs`
- Codex CLI: 독립 실행형 `@openai/codex`; `CODEX_BIN`으로 명시적인 실행 파일이나
  명령 경로를 지정할 수 있고, 그렇지 않으면 PATH에서 `codex`를 찾습니다
- Codex 홈: `.cache/wiki-server/codex-home` 또는 `WIKI_CODEX_HOME`
- 상태 진단: 감지된 Codex 버전과 프로토콜·모델 준비 상태를 분리해 보고하며, 두
  실행 전송 방식 모두 격리된 Codex 홈을 사용합니다
- 실행 방식: app-server 우선, 또는 `WIKI_AGENT_RUNNER=exec`
- 모델: query는 기본 `gpt-5.6-terra`, ingest와 lint는 기본 `gpt-5.6-sol`;
  `WIKI_CODEX_MODEL`은 공통 대체값이며 `WIKI_CODEX_QUERY_MODEL`,
  `WIKI_CODEX_INGEST_MODEL`, `WIKI_CODEX_LINT_MODEL`로 명령별 재정의가 가능합니다
- 추론 강도: 기본 `high`; `WIKI_CODEX_REASONING_EFFORT`은 공통 대체값이며
  `WIKI_CODEX_QUERY_REASONING_EFFORT`, `WIKI_CODEX_INGEST_REASONING_EFFORT`,
  `WIKI_CODEX_LINT_REASONING_EFFORT`로 명령별 재정의가 가능합니다
- 검색: 결정론적 Markdown 그래프 라우팅이 기본 활성화됩니다. 에이전트는 내부
  `wiki-retrieval` 명령으로 본문 없는 메타데이터 검색을 반복한 뒤, 선택한 문서의
  제목·줄 범위·전체 문서를 명시적으로 읽습니다. `log.md`, `raw/**`, 에셋은 일반
  검색 문맥에서 제외되며 `WIKI_GRAPH_RETRIEVAL=0`으로 초기 검색과 반복 검색을
  함께 끌 수 있습니다
- 이벤트 저장: 큰 이벤트 payload는 기존 `raw-events/<jobId>.jsonl` 안에서
  압축되고 API를 통해 투명하게 복원됩니다. 새 레코드를 일반 JSON으로 유지하려면
  `WIKI_SERVER_COMPRESS_EVENT_LOGS=0`을 사용하세요

로컬 클라이언트는 `http://127.0.0.1:55173/client`에서 열 수 있습니다.

`npm run tray`는 Electron 데스크톱 앱을 시작하고 메인 창에서 클라이언트를
엽니다. 데스크톱 렌더러는 호환성 `/client` 웹사이트와 별개입니다. 창을 닫으면
트레이로 숨겨지고 **Open Wiki Server**를 통해 다시 열 수 있습니다. 로그인 시
시작과 분리 실행은 백그라운드에서만 동작합니다.

설치형 앱 데이터와 시각 방향은 `docs/desktop-app.md`, 사용자 소유 위키 관리
표면과 권장 순서는 `docs/user-management-surfaces.md`에 정의되어 있습니다.

압축하지 않은 앱 또는 Windows 설치 파일을 만들려면 다음을 실행합니다.

```powershell
npm run app:pack
npm run app:dist
```

설치 앱은 쓰기 가능한 위키를 `%LOCALAPPDATA%\Wiki Server\wiki-root` 아래에 한 번
초기화합니다. 설치, 업데이트, 제거 과정은 삭제 확인창 없이 이 데이터를
보존합니다.

## API

다른 저장소는 로컬 HTTP API를 직접 호출합니다. 데스크톱 앱의 **Wiki** 화면에는
짧은 연동 가이드가 있고, 표시되는 Base URL은 실제 선택된 포트를 반영합니다.
앱이 대체 포트를 사용한다면 이 가이드를 복사해 사용하세요.

- `POST /query`와 `{ "content": "중립적인 질문" }`
- `POST /ingest`와 `{ "content": "파일 경로, 문서 본문 또는 Source / Ingest context 블록" }`
- `POST /lint`와 본문 없음 또는 `{}`
- `GET /jobs/<jobId>`
- `GET /jobs/<jobId>/events`
- `POST /jobs/<jobId>/cancel`
- `GET /metrics/jobs`
- `GET /health`
- `GET /` 및 `GET /client`

`POST /query`, `/ingest`, `/lint`는 `jobId`, `status`, `eventsUrl`을 포함한
`202` 응답을 반환합니다. 성공한 답은 `result.lastAgentMessage`에서 읽습니다.

그래프 탐색은 별도의 공개 API 계약이 아닙니다. 서버는 격리된 에이전트 환경에
`wiki-retrieval`을 설치하고, 토큰으로 보호되는 루프백 RPC를 내부 프로세스
경계로 사용합니다. 검색 결과는 문서 본문 없이 식별자, 메타데이터, 개정 관계,
그래프 연결, 문서 개요, 사실 일치 필드만 포함합니다. 에이전트가
`wiki-retrieval read`로 대상을 명시적으로 선택한 뒤에만 본문이 문맥에
들어갑니다. ingest로 제출된 일반 텍스트 파일은 경로나 확장자 순위가 아니라
본문 표본으로 판단됩니다.

작업의 `metrics.retrievalObservability`는 후보 사용 비율, 그래프·파일시스템 검색
횟수, 부분·전체 문서 읽기, lint 파티션 범위, 광범위한 루트·제외 경로 접근,
근거·로그 표적 확인, 반복 읽기, 가장 큰 검색 출력을 최선 노력 방식으로
요약합니다. `metrics.executionObservability`는 12,000자 출력 예산, 위반,
완료된 명령의 반복, 토큰·문맥 고수위 값을 별도로 기록합니다. 이 값은 기계적
신호이며 확정적인 파일 읽기 원장, 모델 호출 횟수, 과금 사용량이 아닙니다.

## 검증

```powershell
npm test
npm run typecheck
npm run build
```

실제 Codex app-server 통합 테스트는 선택적으로 실행합니다.

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
npm run test:integration
```

## 위키 소유권

애플리케이션 저장소는 사용자 위키 콘텐츠를 추적하지 않습니다.
`wiki-template/`은 작은 최초 실행용 뼈대일 뿐입니다. 설치된 운영 위키는
독립적으로 버전 관리되며 Wiki 화면에서 열 수 있고 앱 업데이트나 제거 후에도
남습니다. 과거 마이그레이션 세부 내용은 `docs/migration-from-wiki-tools.md`에
있습니다.

Wiki 화면은 시스템 Git 클라이언트가 이해하는 GitHub, GitLab, private HTTPS,
SSH 등 모든 원격에서 운영 위키를 명시적으로 가져올 수 있습니다. 가져오기는 같은
볼륨의 staging 위치에 clone하고 `AGENTS.md`, `index.md`, `wiki/`를 검증한 뒤,
콘텐츠 변경과 타임스탬프가 붙은 백업 경로를 미리 보여줍니다. 이후 로컬 서버를
중지하고 rename 기반으로 원자적 교체를 수행합니다. 기존 위키는 덮어쓰거나
삭제하지 않습니다. pull은 수동이며, fetch 결과 clean 작업 트리가
fast-forward할 수 있을 때만 제공됩니다.

Windows에서는 짧은 형제 staging 경로를 사용하고 가져온 저장소에
`core.longpaths`를 활성화합니다. 따라서 깊은 사용자 에셋 경로가 staging 접두사
때문에 실패하지 않습니다.

인증은 Git Credential Manager 또는 SSH가 담당합니다. 앱은 자격증명이 포함된
HTTPS URL을 거부하고 자격증명 형태의 로그 내용을 가립니다. Wiki Server 설정에
access token, password, SSH key를 저장하지 않습니다.

## 디자인 참고

데스크톱 앱의 시각 방향은 MIT 라이선스로 공개된
[tw93/Kami](https://github.com/tw93/Kami)의 제약 체계를 참고해 재해석했으며,
페이지나 에셋을 그대로 복사하지 않았습니다. 종이 같은 바탕, 절제된 잉크 색상,
타이포그래피 위계, 시각적 소음을 줄이는 방식은 이 앱의 중요한 디자인
참고점이었습니다.

## 라이선스

Wiki Server는 [MIT License](LICENSE)로 배포됩니다.
