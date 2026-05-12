# Web LUFS Meter R&D

브라우저 마이크/오디오 인터페이스 입력을 받아 실시간 LUFS 값을 표시하는 포트폴리오용 R&D 데모입니다.

## 실행

GitHub Pages처럼 HTTPS 환경에서 `index.html`을 열면 바로 사용할 수 있습니다.

로컬 파일(`file://`)로 열면 브라우저에 따라 마이크 권한이 차단될 수 있습니다. 이 경우 로컬 서버 또는 GitHub Pages에서 확인하세요.

## 구현 범위

- Integrated LUFS
- Short-term LUFS
- Realtime LUFS Level Meter
- Loudness Distribution histogram
- LRA 근사값
- Peak Max 표시
- Start / Stop / Reset

## 정확도 메모

이 구현은 ITU-R BS.1770-4에 가까운 웹 기반 근사 구현입니다.

- K-weighting은 RBJ biquad high-pass/high-shelf 필터로 근사했습니다.
- Integrated LUFS는 400ms block, absolute gate -70 LUFS, relative gate를 적용합니다.
- LRA는 short-term loudness 히스토리의 percentile 기반 근사입니다.
- True Peak는 oversampling이 필요하므로 현재는 sample peak max로 표시합니다.
