# Скрипт обновления Bitrix-бота до версии 2.0
# ------------------------------------------
# Этот скрипт создаёт требуемые каталоги и файлы для версии 2.0, 
# добавляет новые зависимости в package.json и ведёт лог выполнения.
# Безопасность: ничего не удаляется, существующие Bitrix/ABCP файлы не затрагиваются.
# Скрипт можно запускать повторно (идемпотентно) – при повторном запуске он просто убедится, что все элементы на месте.

# Определяем путь и имя файла лога
$logFile = "upgrade-log.txt"

# Функция для логирования сообщений (с выводом в консоль и записью в файл)
function Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "$timestamp - $Message"
    Write-Host $entry
    # Записываем сообщение в лог-файл (создаём файл, если его ещё нет)
    Add-Content -Path $logFile -Value $entry
}

# Запускаем логирование начала выполнения
Log "Начало обновления Bitrix-бота до версии 2.0"

# Шаг 1. Создание новой структуры каталогов, если они не существуют
$directories = @(
    "src/core",
    "src/plugins",
    "src/flows",
    "src/responses",
    "src/config",
    "src/utils",
    "src/llm"
)
foreach ($dir in $directories) {
    # Проверяем наличие каталога
    if (-not (Test-Path -Path $dir -PathType Container)) {
        # Создаём каталог (включая промежуточные папки, если нужно)
        New-Item -Path $dir -ItemType Directory | Out-Null
        Log "Создан каталог: $dir"
    }
    else {
        Log "Каталог уже существует: $dir"
    }
}

# Шаг 2. Создание шаблонных файлов, если они отсутствуют
# Определяем содержание шаблонных файлов
# Пустой YAML-шаблон ответов
$responsesYamlContent = @'
# Bot responses (YAML format)
'@
# Пустой JSON-шаблон ответов
$responsesJsonContent = "{}"
# Пример YAML-файла сценария (flow)
$exampleFlowContent = @'
# Example flow configuration
name: Example Flow
steps:
  - id: start
    type: message
    message: "Привет, это начало примера потока."
  - id: end
    type: end
    message: "Конец примера."
'@
# Пример плагина (JavaScript) – обычный плагин
$pluginExampleContent = @'
/**
 * Example plugin for Bitrix bot
 */
module.exports = {
    name: "ExamplePlugin",
    init: (bot) => {
        console.log("Example plugin initialized");
    }
};
'@
# Пример плагина для LLM (JavaScript)
$pluginLLMContent = @'
/**
 * LLM integration plugin for Bitrix bot
 */
module.exports = {
    name: "LLMPlugin",
    init: (bot) => {
        console.log("LLM plugin initialized");
        // TODO: integrate with Large Language Model
    }
};
'@
# Шаблон файла настроек (YAML)
$settingsYamlContent = @'
# Settings for Bitrix Bot v2.0
botName: "BitrixBot"
version: "2.0"
apiKey: "YOUR_API_KEY_HERE"
'@
# Базовая документация (README.md)
$readmeContent = @'
# Бот Bitrix 2.0

Данная версия включает новую структуру проекта с разделением на модули и каталоги.

**Структура каталогов:**
- **src/core**: основные модули ядра бота
- **src/plugins**: подключаемые плагины
- **src/flows**: сценарии (последовательности действий бота)
- **src/responses**: ответы бота (в форматах YAML/JSON)
- **src/config**: конфигурационные файлы (например, settings.yaml)
- **src/utils**: вспомогательные утилиты
- **src/llm**: интеграция с LLM (модули для работы с языковыми моделями)

**Запуск:**  
Файл `src/app.js` является точкой входа бота. Для запуска выполните команду `node src/app.js`.  
Убедитесь, что все зависимости установлены (`npm install`).
'@
# Точка входа приложения (app.js) с подключением модулей и плагинов
$appJsContent = @'
/**
 * Application entry point for Bitrix bot v2.0
 */
const fs = require("fs");
const yaml = require("js-yaml");
const { v4: uuidv4 } = require("uuid");
// Загрузка настроек из YAML
let settings = {};
try {
    const configText = fs.readFileSync(__dirname + "/config/settings.yaml", "utf8");
    settings = yaml.load(configText);
} catch (err) {
    console.error("Не удалось загрузить settings.yaml:", err);
}
// Инициализация плагинов
try {
    const plugin1 = require("./plugins/plugin.example.js");
    if (plugin1 && typeof plugin1.init === "function") { plugin1.init(); }
    const plugin2 = require("./plugins/plugin.llm.js");
    if (plugin2 && typeof plugin2.init === "function") { plugin2.init(); }
    console.log("Plugins initialized");
} catch (err) {
    console.error("Ошибка при инициализации плагинов:", err);
}
// Пример использования UUID (для демонстрации работы зависимости uuid)
console.log("Bot instance ID:", uuidv4());
// Уведомление о успешном запуске бота
console.log("Bot version 2.0 is running");
'@

# Список файлов для проверки/создания с соответствующим содержанием
$filesToCreate = @(
    @{ Path = "src/responses/responses.yaml"; Content = $responsesYamlContent },
    @{ Path = "src/responses/responses.json"; Content = $responsesJsonContent },
    @{ Path = "src/flows/example-flow.yaml"; Content = $exampleFlowContent },
    @{ Path = "src/plugins/plugin.example.js"; Content = $pluginExampleContent },
    @{ Path = "src/plugins/plugin.llm.js"; Content = $pluginLLMContent },
    @{ Path = "src/config/settings.yaml"; Content = $settingsYamlContent },
    @{ Path = "README.md"; Content = $readmeContent },
    @{ Path = "src/app.js"; Content = $appJsContent }
)
foreach ($file in $filesToCreate) {
    $filePath = $file.Path
    # Проверяем, существует ли файл
    if (-not (Test-Path -Path $filePath -PathType Leaf)) {
        # Создаём файл с указанным содержимым
        $file.Content | Set-Content -Path $filePath -Encoding UTF8
        Log "Создан файл: $filePath"
    }
    else {
        Log "Файл уже существует: $filePath"
    }
}

# Шаг 3. Обновление package.json: добавление новых зависимостей, если их нет
$packageFile = "package.json"
if (Test-Path -Path $packageFile -PathType Leaf) {
    # Читаем package.json и парсим в объект PowerShell
    $packageJson = Get-Content -Path $packageFile -Raw | ConvertFrom-Json
    # Убеждаемся, что секция dependencies существует
    if (-not $packageJson.dependencies) {
        $packageJson.dependencies = @{}
    }
    # Необходимые зависимости и версии
    $requiredDeps = @{
        "js-yaml"  = "^4.1.0";
        "glob"     = "^8.0.0";
        "fast-glob"= "^3.2.7";
        "uuid"     = "^8.3.2";
    }
    foreach ($dep in $requiredDeps.GetEnumerator()) {
        $depName = $dep.Key
        $depVersion = $dep.Value
        if ($packageJson.dependencies[$depName] -eq $null) {
            # Добавляем зависимость, если её ещё нет
            $packageJson.dependencies[$depName] = $depVersion
            Log "Добавлена зависимость: $depName ($depVersion)"
        }
        else {
            Log "Зависимость $depName уже присутствует (пропущено)"
        }
    }
    # Сохраняем обновлённый package.json (с форматированием JSON)
    $packageJson | ConvertTo-Json -Depth 10 | Out-File -FilePath $packageFile -Encoding UTF8
} else {
    Log "package.json не найден, пропускаем обновление зависимостей"
}

# Завершаем процесс обновления
Log "Обновление до версии 2.0 выполнено успешно"
