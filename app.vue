<script setup>
import { CindorProvider, CindorSelect } from "cindor-ui-vue";
const route = useRoute();
const themePreference = ref("system");
const resolvedTheme = ref("light");
let systemTheme;

function applyTheme() {
  resolvedTheme.value = themePreference.value === "system"
    ? (systemTheme?.matches ? "dark" : "light")
    : themePreference.value;
  document.documentElement.dataset.theme = resolvedTheme.value;
}

onMounted(() => {
  systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  try {
    const saved = localStorage.getItem("network-dashboard:theme:v1");
    if (["system", "light", "dark"].includes(saved)) themePreference.value = saved;
  } catch { /* Theme switching still works when storage is unavailable. */ }
  applyTheme();
  systemTheme.addEventListener("change", applyTheme);
});
onBeforeUnmount(() => systemTheme?.removeEventListener("change", applyTheme));
watch(themePreference, (value) => {
  try { localStorage.setItem("network-dashboard:theme:v1", value); } catch {}
  applyTheme();
});
const navItems = [
  { label: "Device inventory", to: "/", icon: "grid" },
  { label: "Reserved ranges", to: "/reserved-ranges", icon: "layers" },
  { label: "Network", to: "/network", icon: "network" },
];

useHead({
  titleTemplate: (title) =>
    title ? `${title} · Network Dashboard` : "Network Dashboard",
  meta: [{ name: "theme-color", content: "#142722" }],
  link: [
    { rel: "icon", type: "image/x-icon", sizes: "16x16 32x32 48x48", href: "/favicon.ico?v=2" },
    { rel: "icon", type: "image/svg+xml", sizes: "any", href: "/favicon.svg?v=2" },
    { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
  ],
  script: [{ src: "/theme.js" }],
});
</script>
<template>
  <CindorProvider class="app-provider" :theme="resolvedTheme" theme-family="default">
    <NuxtLoadingIndicator :throttle="0" color="var(--accent)" :height="3" />
    <a class="skip-link" href="#main-content">Skip to content</a>
    <div class="workspace">
      <aside class="app-sidebar">
        <NuxtLink to="/" class="brand" aria-label="Network Dashboard home">
          <span class="brand-mark"><AppIcon name="network" :size="24" /></span>
          <span>network<span class="brand-caption">DASHBOARD</span></span>
        </NuxtLink>
        <nav aria-label="Main navigation" class="main-nav">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            :class="{
              active:
                item.to === '/'
                  ? route.path === '/' || route.path === '/cleanup' || route.path.startsWith('/devices/')
                  : route.path === item.to,
            }"
            :aria-current="route.path === item.to ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" :size="19" />{{ item.label
            }}<AppIcon class="nav-arrow" name="chevron" :size="14" />
          </NuxtLink>
        </nav>
        <label class="theme-control">
          <span>Appearance</span>
          <CindorSelect v-model="themePreference" aria-label="Color theme">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </CindorSelect>
        </label>
      </aside>
      <div class="workspace-body">
        <main id="main-content" class="page-shell" tabindex="-1">
          <NuxtPage />
        </main>
      </div>
    </div>
  </CindorProvider>
</template>
<style>
html {
  font-size: 14px;
  background: #f5f7f8;
}
html[data-theme="dark"] {
  color-scheme: dark;
  background: #101a17;
}
html[data-theme="light"] { color-scheme: light; }
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
.app-provider {
  display: block;
  min-height: 100vh;
  color: var(--fg);
  font-family: "Mona Sans", system-ui, sans-serif;
  --bg: #f5f7f8;
  --surface: #f5f7f8;
  --surface-raised: #fff;
  --surface-inverse: #142722;
  --fg: #1f302c;
  --fg-muted: #65746e;
  --fg-subtle: #6e7c76;
  --fg-faint: #66766c;
  --border: #dbe3df;
  --border-strong: #a4b6ad;
  --border-muted: #e5ebe8;
  --border-hairline: #e5ebe8;
  --accent: #13795d;
  --accent-hover: #0e624b;
  --accent-press: #0b503d;
  --accent-muted: #e7f4ee;
  --accent-fg: #fff;
  --success: #13795d;
  --danger: #be4141;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --text-base: 14px;
  --text-md: 15px;
  --text-lg: 18px;
  --text-xl: 22px;
  --text-2xl: 28px;
  --text-3xl: 34px;
  --text-4xl: 36px;
  --text-helper-size: 12px;
  --ui-border: var(--border);
  --ui-text-muted: var(--fg-muted);
  --ui-surface: var(--surface-raised);
  --ui-surface-subtle: var(--surface);
}
html[data-theme="dark"] .app-provider {
  --bg: #101a17;
  --surface: #16231e;
  --surface-raised: #1b2b24;
  --surface-inverse: #e5f0e9;
  --fg: #e5f0e9;
  --fg-muted: #acbfb3;
  --fg-subtle: #a2b6a9;
  --fg-faint: #9cb0a3;
  --border: #3d5548;
  --border-strong: #6b8b78;
  --border-muted: #33483c;
  --border-hairline: #33483c;
  --accent: #74d8ac;
  --accent-hover: #92e7bf;
  --accent-press: #b0f2d2;
  --accent-muted: #254735;
  --accent-fg: #102b20;
  --success: #7cdbac;
  --danger: #ff9c9c;
  --theme-text: var(--fg);
  --theme-muted: var(--fg-muted);
  --theme-raised: var(--surface-raised);
  --theme-subtle: var(--surface);
  --theme-border: var(--border-muted);
  --theme-success: var(--success);
  --theme-success-bg: #234333;
  --theme-warning: #f4be89;
  --theme-warning-bg: #443322;
  --theme-info: #acc7ff;
  --theme-info-bg: #263952;
  --theme-danger: var(--danger);
}
.theme-control {
  margin-top: auto;
  padding: 24px 12px 4px;
  display: grid;
  gap: 8px;
  font-size: 12px;
}
.theme-control cindor-select {
  --cindor-field-inline-size: 100%;
  color-scheme: dark;
}
.theme-control cindor-select::part(control) {
  width: 100%;
  min-height: 40px;
  padding: 8px 42px 8px 10px;
  border: 1px solid #527362;
  border-radius: 7px;
  background: #20392d;
  color: #e5f0e9;
  color-scheme: dark;
}
.theme-control cindor-select::part(icon) {
  color: #b4c5bd;
}
/* Keep caret placement and text clearance consistent in every dropdown. */
cindor-select::part(icon) {
  inset-inline-end: 14px;
}
cindor-select::part(control) {
  padding-inline-end: 42px;
}
button,
input,
select,
textarea {
  font: inherit;
}
button,
a,
input,
select {
  -webkit-tap-highlight-color: transparent;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
a {
  color: inherit;
  text-decoration: none;
}
button,
a,
input,
select,
textarea {
  outline-offset: 4px;
}
:focus-visible {
  outline: 2px solid var(--theme-success, #168765);
}
.workspace {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  min-height: 100vh;
  background: var(--bg);
}
.app-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 32px 18px 18px;
  background: #142722;
  color: #b4c5bd;
}
.brand {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 10px;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: -1px;
  color: #f2faf6;
}
.brand-mark {
  display: grid;
  place-items: center;
  height: 37px;
  width: 37px;
  background: #a9edca;
  border-radius: 10px;
  color: #173b2e;
}
.brand-caption {
  display: block;
  font-size: 8px;
  letter-spacing: 3.6px;
  margin-top: -2px;
  font-weight: 500;
  color: #adc5b9;
}

.main-nav {
  margin-top: 36px;
  display: grid;
  gap: 6px;
}
.main-nav a {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px;
  border-radius: 7px;
  font-size: 12px;
  transition: background 0.16s;
}
.main-nav a:hover {
  background: #253d31;
  color: white;
}
.main-nav a.active {
  background: #2a4436;
  color: #b9f4d3;
}
.nav-arrow {
  margin-left: auto;
  opacity: 0;
}
.active .nav-arrow {
  opacity: 1;
}

.workspace-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.page-shell {
  padding: 36px;
  max-width: 1800px;
  width: 100%;
  margin: 0 auto;
  flex: 1;
}

.skip-link {
  position: fixed;
  z-index: 100;
  top: -60px;
  left: 20px;
  padding: 12px 20px;
  background: var(--theme-raised, white);
  color: var(--theme-success, #13795d);
}
.skip-link:focus {
  top: 10px;
}
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 38px;
  padding: 9px 14px;
  border: 1px solid var(--theme-border, #dce5df);
  border-radius: 7px;
  background: var(--theme-raised, white);
  color: var(--theme-muted, #45564c);
  font-size: 12px;
  font-weight: 550;
  transition:
    background 0.15s,
    border-color 0.15s;
  white-space: nowrap;
}
.ui-button:hover {
  border-color: var(--theme-border, #98b7a7);
  background: var(--theme-success-bg, #f3f9f5);
}
.ui-button.primary {
  background: #13795d;
  color: white;
  border-color: var(--theme-success, #13795d);
  box-shadow: 0 2px 3px #164b2910;
}
.ui-button.primary:hover {
  background: #0d634b;
}
.ui-button.quiet {
  border-color: transparent;
  background: transparent;
}
.ui-button.icon-only {
  width: 36px;
  padding: 8px;
}
.muted {
  color: var(--fg-muted);
}
.native-select {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  color: var(--fg);
  background: var(--theme-subtle, #f5f7f8);
  font-size: 14px;
}
.mono {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: -0.3px;
}
.eyebrow {
  display: block;
  font-size: 9px;
  letter-spacing: 1.7px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--theme-muted, #6c7d73);
  margin-bottom: 9px;
}
.page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.page-heading h1 {
  font-size: clamp(26px, 2.7vw, 36px);
  font-weight: 600;
  letter-spacing: -1.1px;
}

.heading-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.surface {
  background: var(--theme-raised, #fff);
  border: 1px solid var(--theme-border, #e1e8e3);
  border-radius: 12px;
  box-shadow: 0 3px 8px #243e2a03;
  min-width: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
cindor-card {
  --shadow-sm: 0 3px 8px #243e2a03;
}
cindor-page-header {
  margin-bottom: 6px;
}
.editor-card,
.sidebar-card,
.ip-card,
.panel {
  border-radius: 12px;
}
@media (min-width: 1800px) {
  .page-shell {
    padding: 44px 52px;
  }
}
@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: 190px minmax(0, 1fr);
  }
  .app-sidebar {
    padding-inline: 12px;
  }
  .page-shell {
    padding: 28px 22px;
  }

  .brand {
    font-size: 22px;
  }
}
@media (max-width: 760px) {
  .theme-control {
    margin-top: 0;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .theme-control select {
    width: auto;
    min-width: 120px;
  }
  .workspace {
    display: block;
  }
  .app-sidebar {
    position: relative;
    height: auto;
    padding: 16px;
    gap: 20px;
  }
  .brand {
    font-size: 22px;
    padding: 0;
  }
  .brand-caption {
    font-size: 7px;
  }
  .main-nav {
    margin-top: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .main-nav a {
    flex: 1 1 auto;
    padding: 10px 12px;
  }
  .nav-arrow {
    display: none;
  }

  .page-shell {
    padding: 25px 16px;
  }
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 18px;
  }

  .page-heading h1 {
    font-size: 29px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
</style>
