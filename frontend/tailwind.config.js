/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#161b22',
          elevated: '#21262d',
          border: '#30363d',
        },
        accent: {
          DEFAULT: '#00d4aa',
          hover: '#00f5c4',
          subtle: 'rgba(0, 212, 170, 0.15)',
        },
        danger: {
          DEFAULT: '#f85149',
          hover: '#ff6b63',
          subtle: 'rgba(248, 81, 73, 0.15)',
        },
      },
    },
  },
  plugins: [],
}
