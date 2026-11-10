/** @type {import('tailwindcss').Config} */
const fromVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Values live as CSS variables in src/index.css.
      colors: {
        'shefa-bg': fromVar('shefa-bg'),
        'shefa-panel': fromVar('shefa-panel'),
        'shefa-violet': fromVar('shefa-violet'),
        'shefa-accent': fromVar('shefa-accent'),
      }
    },
  },
  plugins: [],
}
