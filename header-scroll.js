const header = document.querySelector(".site-header");
const lastUploaded = document.querySelector("#last-uploaded");

const syncHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 8);
};

syncHeader();
window.addEventListener("scroll", syncHeader, { passive: true });

if (lastUploaded) {
  const modified = new Date(document.lastModified);

  if (Number.isNaN(modified.getTime())) {
    lastUploaded.textContent = "Upload time unavailable";
  } else {
    lastUploaded.textContent = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Seoul",
    }).format(modified);
  }
}
