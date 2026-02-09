export default function Home() {
  const APK_URL = "https://expo.dev/artifacts/eas/iyVGBTpeLrTDEukCLSdgBk.apk";
  const FORM_URL =
    "https://docs.google.com/forms/d/e/1FAIpQLSeMdylJ-B0Z97PI373XPjYN6c5NrDMmB7igrqYR32cuDhCuGQ/viewform?usp=publish-editor";

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div style={styles.badge}>BETA</div>
          <h1 style={styles.title}>ClassMate</h1>
          <p style={styles.subtitle}>
            고등학생용 시간표 · 과제 · 반 공지 앱 (학생용 베타)
          </p>
        </header>

        <section style={styles.card}>
          <h2 style={styles.h2}>📦 설치하기 (Android)</h2>
          <p style={styles.p}>
            아래 버튼을 눌러 APK를 다운로드한 뒤 설치하세요.
          </p>

          <div style={styles.btnRow}>
            <a href={APK_URL} style={{ ...styles.btn, ...styles.btnPrimary }}>
              APK 다운로드
            </a>
            <a href={FORM_URL} style={{ ...styles.btn, ...styles.btnGhost }}>
              버그/피드백 제출
            </a>
          </div>

          <div style={styles.divider} />

          <h3 style={styles.h3}>설치 방법</h3>
          <ol style={styles.ol}>
            <li>Android에서 위 “APK 다운로드”를 눌러 파일을 받습니다.</li>
            <li>
              설치 중 “알 수 없는 앱 설치” 권한 요청이 뜨면{" "}
              <b>허용</b>합니다.
            </li>
            <li>설치 후 앱을 실행합니다.</li>
          </ol>

          <p style={styles.small}>
            * iOS는 TestFlight/스토어 배포 전이라 현재는 Android 베타만 제공합니다.
          </p>
        </section>

        <section style={styles.card}>
          <h2 style={styles.h2}>✅ 베타에서 가능한 것</h2>
          <ul style={styles.ul}>
            <li>시간표 등록 및 확인</li>
            <li>과제/수행평가 등록</li>
            <li>반 공지 읽기 및 푸시 알림(설정된 경우)</li>
          </ul>

          <h2 style={{ ...styles.h2, marginTop: 20 }}>🧪 베타 참여 가이드</h2>
          <ul style={styles.ul}>
            <li>설치/사용 중 문제가 생기면 피드백 폼으로 바로 알려주세요.</li>
            <li>기종/OS 버전/증상/스크린샷을 같이 보내주면 해결이 빨라요.</li>
          </ul>
        </section>

        <footer style={styles.footer}>
          <span style={styles.footerText}>
            © {new Date().getFullYear()} ClassMate Beta
          </span>
        </footer>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0b1220 0%, #0b1220 30%, #0f172a 100%)",
    color: "#e5e7eb",
    padding: "48px 16px",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
  },
  container: { maxWidth: 760, margin: "0 auto" },
  header: { marginBottom: 18 },
  badge: {
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(59,130,246,0.18)",
    border: "1px solid rgba(59,130,246,0.35)",
    color: "#93c5fd",
    fontWeight: 800,
    fontSize: 12,
    letterSpacing: 0.8,
    marginBottom: 14,
  },
  title: { fontSize: 44, margin: 0, fontWeight: 900, letterSpacing: -0.5 },
  subtitle: {
    marginTop: 10,
    marginBottom: 0,
    color: "rgba(229,231,235,0.75)",
    fontSize: 16,
    lineHeight: 1.6,
    fontWeight: 600,
  },
  card: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 18,
    padding: 18,
    marginTop: 14,
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  },
  h2: { margin: "0 0 10px 0", fontSize: 18, fontWeight: 900 },
  h3: { margin: "0 0 8px 0", fontSize: 15, fontWeight: 900 },
  p: { margin: "0 0 12px 0", color: "rgba(229,231,235,0.78)", fontWeight: 600 },
  btnRow: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 12,
    textDecoration: "none",
    fontWeight: 900,
    fontSize: 14,
    border: "1px solid rgba(255,255,255,0.12)",
  },
  btnPrimary: {
    background: "rgba(59,130,246,0.95)",
    color: "white",
    border: "1px solid rgba(59,130,246,0.95)",
  },
  btnGhost: {
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
  },
  divider: {
    height: 1,
    background: "rgba(255,255,255,0.10)",
    margin: "14px 0",
  },
  ol: { margin: 0, paddingLeft: 18, color: "rgba(229,231,235,0.8)", fontWeight: 600 },
  ul: { margin: 0, paddingLeft: 18, color: "rgba(229,231,235,0.8)", fontWeight: 700 },
  small: { marginTop: 10, fontSize: 12, color: "rgba(229,231,235,0.6)", fontWeight: 600 },
  footer: { marginTop: 18, paddingTop: 8, opacity: 0.7 },
  footerText: { fontSize: 12, fontWeight: 700 },
};