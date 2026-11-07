# Передача backend-части команде

Ветка: `feature/backend-finalization`. Push/PR не входят в эту передачу, пока владелец ветки не решит иначе.

Ответственность этой части: Next.js API, PostgreSQL, Zod, GigaChat, миграции, seed, подготовка к деплою, документация API.

Не входит: UI Димы, методология/новые маршруты Алисы, выбор и покупка серверов, юридическая рамка 152-ФЗ.

## Что сделано

- Сессия, трек, диагностика, 6 уточнений, рекомендации, рефлексия пишутся в PostgreSQL и читаются обратно API.
- Каталог профессий/программ/проб из Excel (seed) + overlay `data/navigator_full_graph.json`.
- Вопросы диагностики и агента читаются из JSON (`bilet_questions_master.json`, `agent_clarification.json`) — это справочник, не ответы ученика.
- GigaChat: ограниченный каталог в промпте, нормализация ответа модели, без выдуманных контактов и RIASEC-баллов школьника.
- Документы: `docs/API.md`, `docs/FRONTEND_HANDOFF.md`, `docs/DEPLOY.md`, `docs/MVP_STATUS.md`.

## Где что лежит в PostgreSQL

| Данные школьника | Таблицы | Запись | Чтение |
|---|---|---|---|
| Сессия и трек | `sessions` | `POST /api/track/select` | `GET /api/session` |
| Профиль (класс 8–11, город) | `profiles` | сейчас в основном `db:seed:mocks` | `GET /api/session` |
| Диагностика | `diagnostics`, `diagnostic_answers` | `POST /api/diagnostic/submit` | `GET /api/diagnostic/latest`, `GET /api/session` |
| Уточнения | `clarifications`, `clarification_answers` | `POST /api/clarification/submit` (и опционально вместе с диагностикой / generate) | latest + session |
| Рекомендации | `recommendations` (JSONB hypotheses + pathways) | `POST /api/recommendations/generate` | `GET /api/recommendations`, `GET /api/session` |
| Рефлексия | `reflections` | `POST /api/reflection` | `GET /api/reflection`, `GET /api/session` |

Каталог (профессии, программы, пробы, организации) — справочник Алисы, не персональные данные.

## Ограничение доступа

`X-Session-ID` идентифицирует строку в `sessions`, но не аутентифицирует человека. RLS нет. До реальных школьников нужна модель доступа (решение продукта + инфраструктура).

## Как проверить локально

```bash
cp .env.example .env.local   # затем вписать реальные секреты локально, не в Git
docker compose up -d db
npm install
npm run db:migrate
npm run db:seed
npm run dev
npm test
npm run e2e:storage
npm run e2e:mocks:persist
```

`e2e:storage` создаёт **новые** UUID и ничего не удаляет. Прогон 2026-11-01 на `localhost:3002`: 30/30, generate HTTP 201, GET рекомендации и рефлексии совпали с записанным. 15 мок-диагностик записаны и прочитаны; GigaChat для учеников 2, 8, 15 — 3/3 с повторной загрузкой из БД.

## Для Серёжи

- Generate: успех **201**, не 202. 502 — ошибка модели, не успех.
- Новые GET: `/api/session`, `/api/reflection`, `/api/diagnostic/latest`, `/api/recommendations`.
- Интеграционные тесты только на отдельной БД.

## Для Алисы

В каталоге часто нет кружков и онлайн-курсов с проверенными ссылками. API тогда отдаёт `available: false`. Это не баг backend.

Мок-файл 15 учеников содержит диагностику «Билет в будущее», но **не** 6 ответов агента. Их нельзя выдумать.

## Для инфраструктуры

См. `docs/DEPLOY.md`. Кратко: Postgres 16, `DATABASE_URL`, при облаке `PGSSL=true`, секреты только в env, миграции вручную до трафика, GigaChat может быть недоступен с публичных IP. Деплой из этой роли не выполнялся.

## Что осталось вне этой части

- Авторизация и 152-ФЗ.
- Наполнение кружков/курсов (Алиса).
- UI (Дима).
- Выбор хостинга и фактический выкат.
- Прогон generate для всех 15 учеников (дорого по квоте; репрезентативно — 2, 8, 15).
