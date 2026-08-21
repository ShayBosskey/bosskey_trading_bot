/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bosskey-dark': '#0B1115',
        'bosskey-panel': '#161D22',
        'bosskey-green': '#A1E533',
      }
    },
  },
  plugins: [],
}
