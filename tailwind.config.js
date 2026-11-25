/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      backdropBlur: {
        xs: '2px',
      },
      colors: {
        surface: {
          0: '#0b0d10',
          1: '#111419',
          2: '#171b22',
          3: '#1e242d',
        },
        accent: {
          DEFAULT: '#e11d48',
          hover: '#f43f5e',
        },
        glass: 'rgba(255, 255, 255, 0.06)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
    },
  },
  plugins: [],
};
