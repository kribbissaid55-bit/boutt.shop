/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'Cairo', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef9f3',
          100: '#d4f0e1',
          500: '#1f9d55',
          600: '#188a4a',
          700: '#106e3a',
        },
      },
    },
  },
  plugins: [],
};
