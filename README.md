# Wiki Server

**한국어** | [English](README.en.md)

내가 쓰는 운영 위키를 로컬에서 유지하기 위해 만든 에이전트 서버다.

범용 위키 앱을 만들려는 프로젝트는 아니다. 작업을 받아 Codex로 실행하고, 그
과정을 관찰하고, 위키를 Git으로 보존하는 데 필요한 것들을 한곳에 묶어둔 형태에
가깝다. 내가 작업하고 인지하는 방식과 밀접하게 연결되어 있어서 다른 사람이
그대로 쓰기에는 맞지 않을 수 있지만, 코드와 설계는 참고할 수 있도록 열어둔다.

실제 위키는 `%LOCALAPPDATA%\Wiki Server\wiki-root` 아래의 별도 Git 저장소에
있으며 private으로 유지한다. 이 저장소에는 서버, 데스크톱 앱, 테스트, 설계 문서,
최소 초기 템플릿만 들어간다. 작업 기록과 캐시는 로컬 런타임 데이터로 남고 Git에
올리지 않는다.

서비스는 인증이 없는 로컬 전용 서버다. 인증과 네트워크 제어를 따로 추가하지
않았다면 로컬 컴퓨터 밖으로 노출하면 안 된다.

저장소의 소유권과 공개 API 경계는 `AGENTS.md`, 모듈별 변경 위치는
`docs/code-map.md`, 검증 기준은 `docs/code-quality.md`에 정리되어 있다.

## 실행

```powershell
npm install
npm run dev
```

Node.js는 `.node-version`을 통해 `24.15.0`으로 고정한다. fnm을 쓴다면 저장소에서
새 셸을 열거나 `fnm use`를 실행하면 된다.

기본값은 다음과 같다.

- 호스트: `127.0.0.1`
- 포트: `55173`; 이미 사용 중이면 데스크톱 앱이 인접한 빈 포트를 고른다
- 위키 루트: `WIKI_ROOT`; 소스 개발 환경에서는 형제 디렉터리 `..\wiki`를
  대체 경로로 사용한다
- 런타임 데이터: `.cache/wiki-server` 또는 `WIKI_SERVER_DATA_DIR`
- 작업 데이터: `.cache/wiki-server/jobs`
- Codex CLI: `CODEX_BIN`으로 지정한 실행 파일, 아니면 PATH의 `codex`
- Codex 홈: `.cache/wiki-server/codex-home` 또는 `WIKI_CODEX_HOME`
- 실행 방식: app-server 우선, `WIKI_AGENT_RUNNER=exec`으로 exec 고정 가능
- 모델: query는 기본 `gpt-5.6-terra`, ingest와 lint는 기본 `gpt-5.6-sol`;
  `WIKI_CODEX_MODEL` 또는 명령별 환경 변수로 바꿀 수 있다
- 추론 강도: 기본 `high`; 공통 또는 명령별 환경 변수로 바꿀 수 있다
- 검색: Markdown 링크 그래프를 먼저 좁힌 뒤 내부 `wiki-retrieval` 명령으로
  메타데이터 검색과 선택적 읽기를 반복한다. `WIKI_GRAPH_RETRIEVAL=0`으로 끌 수
  있다
- 이벤트 저장: 큰 이벤트 payload는 `raw-events/<jobId>.jsonl` 안에서 압축한다.
  `WIKI_SERVER_COMPRESS_EVENT_LOGS=0`이면 새 레코드를 일반 JSON으로 남긴다

로컬 웹 클라이언트는 `http://127.0.0.1:55173/client`에서 열린다.

```powershell
npm run tray       # Electron 데스크톱 앱
npm run app:pack   # 압축하지 않은 앱 빌드
npm run app:dist   # Windows 설치 파일 빌드
```

설치 앱은 위키를 `%LOCALAPPDATA%\Wiki Server\wiki-root`에 한 번 초기화한다.
업데이트하거나 앱을 제거해도 위키와 런타임 데이터는 남는다. 설치형 앱의 데이터
경계와 화면 설계는 `docs/desktop-app.md`에 정리되어 있다.

## API

다른 저장소에서는 로컬 HTTP API를 직접 호출한다.

- `POST /query`와 `{ "content": "question text" }`
- `POST /ingest`와 `{ "content": "file path, document text, or context" }`
- `POST /lint`와 본문 없음 또는 `{}`
- `GET /jobs/<jobId>`
- `GET /jobs/<jobId>/events`
- `POST /jobs/<jobId>/cancel`
- `GET /metrics/jobs`
- `GET /health`
- `GET /` 및 `GET /client`

`POST /query`, `/ingest`, `/lint`는 바로 실행 결과를 돌려주지 않는다. `202`와 함께
`jobId`, `status`, `eventsUrl`을 반환하고, 성공한 답은
`result.lastAgentMessage`에 남는다.

그래프 탐색은 공개 API가 아니라 서버 내부 경계다. 검색 결과에는 문서 본문 대신
식별자, 메타데이터, 개정 관계, 연결, 문서 개요와 일치 필드만 들어간다. 에이전트가
`wiki-retrieval read`로 문서와 범위를 고른 뒤에만 본문이 문맥에 들어간다.
`log.md`, `raw/**`, 에셋은 일반 검색에서 제외한다.

작업 결과에는 검색과 실행을 보기 위한 `retrievalObservability`와
`executionObservability`가 붙는다. 후보 사용, 그래프·파일시스템 검색, 부분·전체
문서 읽기, 출력 예산, 가장 크게 관찰된 토큰·문맥 값 같은 기계적 신호다. 파일
읽기 원장이나 모델 호출 횟수, 과금 사용량으로 보면 안 된다.

## 위키와 Git

애플리케이션 저장소는 사용자의 위키 내용을 추적하지 않는다. `wiki-template/`은
새 설치에 필요한 최소 뼈대일 뿐이다. 운영 위키는 앱과 독립된 Git 이력을 가지며,
앱 업데이트나 제거와 상관없이 남는다.

데스크톱 앱의 **Wiki** 화면에서 GitHub, GitLab, private HTTPS, SSH 등 시스템 Git
클라이언트가 다룰 수 있는 원격 저장소를 가져올 수 있다. 가져오기 전에 `AGENTS.md`,
`index.md`, `wiki/` 구조를 확인하고 현재 위키와의 변경점, 백업 경로를 보여준다.
적용할 때는 기존 위키를 타임스탬프가 붙은 경로로 옮긴 뒤 검증한 저장소로
교체한다. 기존 데이터를 덮어쓰거나 삭제하지 않는다.

pull은 자동 동기화가 아니라 명시적인 작업이다. fetch 결과 현재 작업 트리가
clean이고 fast-forward 가능한 경우에만 실행한다. 인증은 Git Credential Manager나
SSH에 맡기며, 앱은 자격증명이 들어간 URL을 거부하고 토큰이나 비밀번호, SSH key를
저장하지 않는다.

## 검증

```powershell
npm test
npm run typecheck
npm run build
```

실제 Codex app-server 통합 테스트는 필요할 때만 켠다.

```powershell
$env:WIKI_RUN_CODEX_INTEGRATION = "1"
npm run test:integration
```

## 디자인

데스크톱 앱은 MIT 라이선스로 공개된
[tw93/Kami](https://github.com/tw93/Kami)의 시각 제약을 많이 참고했다. 페이지나
에셋을 그대로 가져온 것은 아니고, 종이 같은 바탕, 절제된 잉크 색상, 타이포그래피
위계, 시각적 소음을 줄이는 방식을 이 앱의 구조에 맞게 다시 적용했다.

## 라이선스

라이선스는 [MIT License](LICENSE)다.
