// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  // Builds clear buildDir; keep them away from the running dev server's files.
  $production: { buildDir: '.nuxt-build' },
  ignore: ['.nuxt-build/**'],
  // Shared collectors/registry are external modules in Nitro development.
  nitro: { devServer: { watch: ['scripts/**/*.js', 'utils/**/*.js'] } },
  devtools: { enabled: true },
  css: ["cindor-ui-core/styles.css"],
  runtimeConfig: {
    UNIFI_HOST: process.env.UNIFI_HOST,
    UNIFI_USER: process.env.UNIFI_USER,
    UNIFI_PASS: process.env.UNIFI_PASS,
    HA_URL: process.env.HA_URL,
    HA_TOKEN: process.env.HA_TOKEN,
    NAGIOS_URL: process.env.NAGIOS_URL,
    NAGIOS_USER: process.env.NAGIOS_USER,
    NAGIOS_PASS: process.env.NAGIOS_PASS,
  }
})
