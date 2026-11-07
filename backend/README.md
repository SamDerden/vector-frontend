# Профессиональный навигатор — backend

Backend MVP для школьной профориентации (Екатеринбург). Стек: Next.js 15 Route Handlers, TypeScript, PostgreSQL 16, Zod, GigaChat через OpenAI-совместимый Chat Completions API.

Целевой сценарий: школьник выбирает трек, проходит диагностику, при необходимости отвечает на 6 уточняющих вопросов, получает гипотезы профессий и три варианта следующего шага (кружок, колледж, онлайн-курс) **только из проверенного каталога**. Числовые RIASEC-баллы школьника не считаются. Передача урезанного каталога в LLM — не векторный RAG.

## Что реализовано

- PostgreSQL 16 (Docker Compose), аддитивные миграции, seed каталога из Excel.
- Сессии, диагностика, уточняющие ответы, рекомендации, рефлексия.
- JSON-данные: `data/agent_clarification.json` (6 вопросов), `data/bilet_questions_master.json`, `data/mock_students_data.json` (15 учеников), `data/navigator_full_graph.json` (overlay графа).
- API (см. `docs/API.md`):
  - `GET /api/health`
  - `POST /api/track/select`
  - `GET /api/session`
  - `GET /api/diagnostic/questions`
  - `POST /api/diagnostic/submit`
  - `GET /api/diagnostic/latest`
  - `GET /api/clarification/questions`
  - `POST /api/clarification/submit`
  - `POST /api/recommendations/generate`
  - `GET /api/recommendations`
  - `GET /api/trials`
  - `GET /api/professions`, `GET /api/professions/[id]`
  - `POST /api/reflection`, `GET /api/reflection`
- Zod для старых и новых payload. Идентификатор сессии — заголовок `X-Session-ID` (UUID).

Статус готовности: `docs/MVP_STATUS.md`. Подготовка хостинга: `docs/DEPLOY.md`.

## Запуск локально

Требования: Docker Desktop, Node.js 22+, npm.

1. Скопировать переменные (фиктивные значения, без реальных секретов в Git):
   ```bash
   cp .env.example .env.local
   ```
2. Запустить PostgreSQL:
   ```bash
   docker compose up -d db
   ```
3. Установить зависимости:
   ```bash
   npm install
   ```
4. Миграции и каталог:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
   Опционально 15 тестовых сессий с ответами:
   ```bash
   npm run db:seed:mocks
   ```
   UUID мок-сессии: `11111111-1111-4111-8111-` + `student_id` с паддингом до 12 знаков (ученик 1 → `...000000000001`).
5. Приложение:
   ```bash
   npm run dev
   ```
6. Проверка: `http://localhost:3000/api/health`.

`DATABASE_URL` на хосте использует `localhost:5433`. В app-контейнере — hostname `db`.

## Полный запуск в Docker

```bash
docker compose up --build
docker compose exec app npm run db:migrate
docker compose exec app npm run db:seed
```

## Проверки

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e:storage
npm run e2e:mocks
```

`e2e:storage` требует запущенный API и PostgreSQL; создаёт новые сессии и не удаляет данные. `e2e:mocks:persist` записывает 15 мок-диагностик через API; `--ai=3` вызывает GigaChat только для учеников 2, 8 и 15.

Smoke API (нужен запущенный `npm run dev` и миграции):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-api.ps1
```

`POST /api/recommendations/generate` в smoke-тесте допускает 201/502/503/504: успех зависит от ключа и сети до AI Gateway. Интеграционные тесты с реальной БД запускайте только против **отдельной** тестовой базы.

## Примеры API

Сессия передаётся заголовком `X-Session-ID`, не полем JSON.

### Трек

```bash
curl -X POST http://localhost:3000/api/track/select \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: 6f9619ff-8b86-4011-a42d-00cf4fc964ff" \
  -d '{"trackType":"explore"}'
```

`trackType`: `explore`, `interests`, `known_direction`.

### Диагностика

```bash
curl -X POST http://localhost:3000/api/diagnostic/submit \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: 6f9619ff-8b86-4011-a42d-00cf4fc964ff" \
  -d '{"answers":[{"questionId":"q1","answer":"technology"},{"questionId":"q2","answer":true}]}'
```

Сначала нужен `/api/track/select`. Опционально в том же теле: `clarificationAnswers` (1–6 вопросов агента).

### Уточнения

```bash
curl http://localhost:3000/api/clarification/questions
curl -X POST http://localhost:3000/api/clarification/submit \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: 6f9619ff-8b86-4011-a42d-00cf4fc964ff" \
  -d '{"answers":[{"questionId":"agent_q2_work_style","answer":"team"}]}'
```

### Рекомендации

Нужны `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL` в `.env.local` и сохранённая диагностика.

```bash
curl -X POST http://localhost:3000/api/recommendations/generate \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: 6f9619ff-8b86-d011-b42d-00cf4fc964ff"
```

Успех — **201**. В ответе есть прежние поля (`summary`, `hypotheses`, `trials`, `nextStep`) и аддитивное `nextStepOptions` (кружок / колледж / курс). Если в каталоге нет проверенных данных, `available: false` и пояснение, контакты не выдумываются.

`fitScore` — относительный порядок гипотез модели (`scoreKind: "relative_ranking"`), не процент соответствия и не RIASEC школьника.

## Ограничения

- `X-Session-ID` не является аутентификацией. Знание UUID даёт доступ к данным сессии.
- Административный login и RLS не реализованы.
- Перед реальными школьниками нужны 152-ФЗ, согласия и политика хранения.
- `.env.local` и секреты не коммитить.
- Деплой в облако не выполнялся из этой ветки; см. `docs/DEPLOY.md`.
