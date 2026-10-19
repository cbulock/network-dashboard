// Apply the saved appearance before the page paints or Vue hydrates.
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("network-dashboard:theme:v1");
    if (["light", "dark", "system"].includes(saved)) preference = saved;
  } catch { /* Use the system preference when storage is unavailable. */ }
  document.documentElement.dataset.theme = preference === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
})();
