const header = document.querySelector(".site-header");

const syncHeader = () => {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 8);
};

syncHeader();
window.addEventListener("scroll", syncHeader, { passive: true });
