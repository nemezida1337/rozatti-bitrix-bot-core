// eslint.config.cjs — flat config для ESLint 9

const importPlugin = require("eslint-plugin-import");

module.exports = [
  // Что игнорировать
  {
    ignores: ["node_modules/**", "data/**", "_runtime/**"]
  },

  // Основной конфиг для исходников
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        module: "readonly"
      }
    },
    plugins: {
      import: importPlugin
    },
    rules: {
      // Базовые правила
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",

      // Красивый порядок импортов
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true }
        }
      ]
    }
  }
];
