# Развёртывание backend MVP

Инструкция описывает **подготовку** бесплатного или условно-бесплатного хостинга Next.js + PostgreSQL. Она **не подтверждает**, что выбранный тариф останется бесплатным, что GigaChat доступен с облачных IP или что деплой уже выполнен. Деплой в облако без отдельного разрешения не производился.

Рекомендуемая связка для учебной среды: **Vercel** (приложение) + **Supabase** (PostgreSQL 15/16). Локально по-прежнему используется Docker PostgreSQL 16.

## Что нужно заранее

- Аккаунты Vercel и Supabase (или другой хост Postgres).
- Доступ к AI Gateway (совместимый с OpenAI Chat Completions) для GigaChat. Если шлюз доступен только из корпоративной сети, облачный Vercel **не сможет** вызвать модель.
- Каталог `data/Навигатор ЕКБ v1.xlsx` и JSON в `data/` должны попасть в сборку (они копируются через `outputFileTracingIncludes` и Dockerfile).
- Секреты только в панели хостинга, не в Git. Не копируйте значения из `.env.local`.

## Ограничения тарифов (проверить на дату деплоя)

Значения ниже — типичные ограничения публичных тарифов на конец 2026 года; перед деплоем сверьтесь с текущими страницами тарифов.

| Сервис | Что обычно даёт бесплатный/hobby тариф | Риск для этого проекта |
|---|---|---|
| Vercel Hobby | Serverless/Node runtime, лимиты по длительности функции и числу вызовов | Генерация рекомендаций держит HTTP-запрос до `AI_TIMEOUT_MS` (по умолчанию 45 с). Если лимит функции меньше, клиент получит обрыв. |
| Supabase Free | Небольшой Postgres, проект может **засыпать** при простое | После паузы первые запросы к `/api/health` вернут 503, пока база не проснётся. |
| Connection pooling | Порт 6543 (transaction pooler) vs 5432 (прямое соединение) | `pg` с транзакциями (`BEGIN` на диагностике) лучше направлять на **session pooler / direct** (обычно 5432), не на transaction mode, либо использовать pooler с поддержкой подготовленных транзакций. |
| GigaChat / AI Gateway | Сетевой allowlist, квоты, ключ | С IP Vercel шлюз может отвечать 401/403/timeout. Это блокера облачного MVP, не баг кода. |

## 1. База данных (Supabase)

1. Создайте проект. Регион ближе к пользователям (например Frankfurt / Stockholm).
2. В Settings → Database скопируйте URI. В `.env` хостинга используйте **подставные** имена, реальный пароль только в панели:
   - `DATABASE_URL=postgresql://postgres.<project>:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres`
   - `PGSSL=true`
   - `PGSSL_REJECT_UNAUTHORIZED=true` (оставьте true, если сертификат проверяется)
3. Примените миграции **с машины, у которой есть сеть до Supabase**, не из продакшен-кода при каждом запросе:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
   Для seed нужен Excel-каталог. `npm run db:seed:mocks` загружает 15 тестовых учеников как сессии с диагностикой; не запускайте это на базе с реальными школьниками.
4. Не выполняйте `DROP`/`TRUNCATE` и не указывайте production URL в локальных экспериментах.

Миграции аддитивные: `001_initial_schema.sql`, `002_catalog_extension.sql`, `003_clarifications_and_pathways.sql`.

## 2. Приложение (Vercel)

1. Импортируйте репозиторий. Framework preset: Next.js.
2. Environment variables (фиктивные примеры, не секреты):
   ```
   DATABASE_URL=postgresql://postgres.xxxx:replace-with-password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   PGSSL=true
   AI_API_BASE_URL=https://litellmru.ds-hub-cf.ru/v1
   AI_API_KEY=replace-with-ai-gateway-key
   AI_MODEL=GigaChat-2-Pro
   AI_TIMEOUT_MS=45000
   ```
3. Root directory — корень этого проекта (`package.json` с `next`).
4. Build command: `npm run build`. Install: `npm install`.
5. После деплоя проверьте `GET /api/health`. Ожидается `database: "connected"`. Поле `aiConfigured` равно `true`, только если заданы три AI-переменные; это **не** проверка, что шлюз отвечает.
6. Затем `GET /api/professions` — каталог должен быть непустым после seed.

## 3. Проверка сети до GigaChat

С локальной машины (если шлюз доступен):

```bash
curl -X POST http://localhost:3000/api/recommendations/generate \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: <uuid-сессии-с-диагностикой>" \
  -d "{}"
```

Ожидаемые статусы:

- `201` — модель ответила, результат сохранён.
- `502` — шлюз или JSON модели непригодны.
- `503` — нет конфигурации AI или пустой каталог / устаревшая схема.
- `504` — таймаут.

С Vercel тот же запрос может получить `502`/`504`, если корпоративный шлюз недоступен из интернета. Тогда варианты (согласовать отдельно): туннель/прокси в разрешённой сети, другой endpoint, или ручной прогон рекомендаций только локально.

## 4. Docker (альтернатива облаку)

```bash
docker compose up --build
docker compose exec app npm run db:migrate
docker compose exec app npm run db:seed
```

`DATABASE_URL` внутри app-контейнера указывает на хост `db`, с хоста — на `localhost:5433`.

Секреты (`AI_API_KEY`, пароль Postgres) только в env хоста или Docker secrets, не в образе и не в Git. `.env.local` в `.gitignore`.

После старта контейнера миграции **не** выполняются сами: их нужно вызвать отдельно (`docker compose exec app npm run db:migrate`). Приложение без миграции 003 не сохранит уточнения и `pathways`.

Проверка после выката (делает инфраструктура, не этот репозиторий): `GET /api/health`, `GET /api/professions`, затем один generate на тестовой сессии.

## 5. Чего эта инструкция не делает

- Не деплоит проект.
- Не гарантирует бесплатность тарифов.
- Не настраивает авторизацию, RLS и соответствие 152-ФЗ.
- Не открывает доступ к GigaChat с облачных IP.
