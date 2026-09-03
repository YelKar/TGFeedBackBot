# TGFeedBackBot (Cloudflare Workers + D1 + React TS)

Телеграм-предложка: пользователи предлагают посты, модераторы голосуют (1–5),
одобренные автоматически ставятся в очередь и публикуются в канал.

Весь проект переписан на TypeScript:

| Компонент | Технология | Где |
|---|---|---|
| Бот (webhook) + HTTP API + cron | Cloudflare Worker, grammY | `cf/src/` |
| База данных | Cloudflare D1 (SQLite) | `cf/migrations/` |
| Веб-интерфейс модерации | React 19 + TypeScript + Tailwind 4 | `cf/ui/` |
| Тесты | Vitest | `cf/tests/` |

## Структура

```
cf/
├── wrangler.jsonc          # конфиг воркера (D1, cron, assets)
├── migrations/0001_init.sql # схема D1
├── src/
│   ├── index.ts            # роуты: /webhook, /api + cron
│   ├── bot.ts              # хендлеры бота (команды, callback-кнопки)
│   ├── bot_util.ts         # apply_action, карточки постов, публикация
│   ├── db.ts               # слой D1
│   ├── scheduler.ts        # очередь публикации (слоты, лимиты)
│   ├── rating.ts           # робастная оценка голосов (M-estimator)
│   └── tg.ts               # verify initData, entities → HTML
├── ui/                     # веб-интерфейс (Mini App)
└── tests/                  # vitest: rating + scheduler
```

## Требования

- Node.js ≥ 20
- Аккаунт Cloudflare (free-тарифа достаточно)

## Деплой с нуля

### 1. Установка зависимостей

```bash
cd cf
npm install
cd ui && npm install && cd ..
```

### 2. Создаём базу D1

```bash
npx wrangler d1 create tgfeedback
```

Скопируйте `database_id` из вывода и вставьте в `cf/wrangler.jsonc`.

### 3. Применяем схему

```bash
npm run db:remote
```

### 4. Конфигурируем переменные

В `cf/wrangler.jsonc` в `vars.CHAT_ID` укажите ID чата модерации.

Секреты (по очереди, каждая команда спросит значение):

```bash
npx wrangler secret put TOKEN         # токен бота от @BotFather
npx wrangler secret put CHANNEL_ID    # ID канала публикации
npx wrangler secret put WEBHOOK_SECRET  # любая случайная строка для защиты вебхука
```

### 5. Собираем UI и деплоим

```bash
(cd ui && npm run build)
npm run deploy
```

Wrangler напечатает URL вида `https://tgfeedbackbot.<account>.workers.dev`.

### 6. Подключаем вебхук Telegram

```bash
curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
  -d "url=https://tgfeedbackbot.<account>.workers.dev/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

### 7. Конфиг планировщика

В таблице `config` нужен JSON с расписанием:

```sql
INSERT OR REPLACE INTO config (key, value) VALUES ('scheduler', '{
  "preferred_slots": ["10:00", "18:00"],
  "min_interval": 3600,
  "window_start": 9,
  "window_end": 22,
  "posts_per_day": 2
}');
```

Удобно выполнить через `npx wrangler d1 execute tgfeedback --remote --command "..."`.
Часовой пояс очереди — UTC+3 (`TZ_OFFSET_MS` в `src/scheduler.ts`).

## Локальная разработка

```bash
# Терминал 1 — воркер (+ собранный UI на :8787)
cd cf && npx wrangler dev

# Терминал 2 — UI с hot-reload на :5173
cd cf/ui && npm run dev
```

Для проверки UI локально открывайте `http://localhost:5173/?api=http://localhost:8787/api`
(без Telegram initData API вернёт 401 — это нормально; для полного цикла нужен вебхук).

Чтобы бот в реальном Telegram работал на локальный воркер:

```bash
cloudflared tunnel --url http://localhost:8787
# затем setWebhook на полученный trycloudflare.com URL + /webhook
```

## Dev / Prod

Окружения разделены через environments в `cf/wrangler.jsonc`:

| | Dev (по умолчанию) | Production |
|---|---|---|
| Воркер | `come-up-with-a-name-bot` | `come-up-with-a-name-bot-prod` |
| D1 | `tgfeedback` | `tgfeedback-prod` |
| Деплой | `npm run deploy` | `npm run deploy:prod` |
| Секреты | `wrangler secret put X` | `wrangler secret put X --env production` или дашборд |

Первичная настройка prod:

```bash
npx wrangler d1 create tgfeedback-prod   # id → в wrangler.jsonc env.production
npm run db:remote:prod                   # схема всех трёх миграций
# конфиг scheduler — тот же INSERT, но на tgfeedback-prod
npx wrangler secret put TOKEN --env production
npx wrangler secret put CHANNEL_ID --env production
npx wrangler secret put WEBHOOK_SECRET --env production
# CHAT_ID в wrangler.jsonc → env.production.vars
npm run deploy:prod
curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
  -d "url=https://come-up-with-a-name-bot-prod.<субдомен>.workers.dev/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Рекомендуется завести отдельного тестового бота в @BotFather и указать его токен
в dev-окружении, чтобы не дёргать живую аудиторию.

## Проверки

```bash
cd cf && npm run check && npm test      # воркер: tsc + vitest (15 тестов)
cd cf/ui && npm run check               # UI: tsc strict
```

## Миграция данных из YDB (опционально)

1. Выгрузите таблицы YDB (`post`, `vote`, `config`, `blocked_user`, `dialogue`)
   через `ydb` CLI в JSON/CSV.
2. Сгенерируйте `INSERT INTO ... VALUES (...)` (времена переведите из
   микросекунд YDB в **миллисекунды** epoch).
3. Выполните: `npx wrangler d1 execute tgfeedback --remote --file=import.sql`.

## Отличия от Python-версии

- Только webhook (long-polling в Workers невозможен).
- Время хранится в миллисекундах (было в микросекундах).
- Голосование обновляет статус оптимистично; гонку параллельных голосов
  раз в час заживляет сверка pending-постов в cron.
- Исправлен баг UI: список голосов теперь реально отображается
  (в старом `RatingDisplay` читал не то поле).
