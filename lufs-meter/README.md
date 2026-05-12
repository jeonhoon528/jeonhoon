# Web LUFS Meter R&D

브라우저 탭/시스템 오디오 공유 신호를 받아 실시간 LUFS 값을 표시하는 포트폴리오용 R&D 데모입니다.

## 실행

GitHub Pages처럼 HTTPS 환경에서 `index.html`을 열면 바로 사용할 수 있습니다.

`Start Tab Audio`를 누르면 브라우저의 탭/화면 공유 창이 열립니다. YouTube 임베드 영상이 재생되는 현재 탭을 선택하고, 오디오 공유 옵션을 반드시 켜야 합니다.

로컬 `file://` 환경에서는 브라우저 정책에 따라 탭 오디오 공유가 제한될 수 있습니다. 실제 확인은 GitHub Pages 또는 로컬 HTTPS 서버에서 하는 것을 권장합니다.

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

- YouTube iframe 오디오는 보안 정책상 Web Audio API에 직접 연결할 수 없어 `getDisplayMedia`의 탭 오디오 캡처를 사용합니다.
- K-weighting은 RBJ biquad high-pass/high-shelf 필터로 근사했습니다.
- Integrated LUFS는 400ms block, absolute gate -70 LUFS, relative gate를 적용합니다.
- LRA는 short-term loudness 히스토리의 percentile 기반 근사입니다.
- True Peak는 oversampling이 필요하므로 현재는 sample peak max로 표시합니다.
