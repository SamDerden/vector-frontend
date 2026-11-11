# Дополнение API для frontend

Дата сверки: 11.11.2026. Ветка `fix/backend-integration-stability`. Это добавления к `API.md`. Старые поля и статусы сохранены.

Проверка ownership включается в `NODE_ENV=production` и при `SESSION_PROOF_ENFORCED=true`. Это поведение `origin/main`. Вне production и без флага клиент по-прежнему передаёт только `X-Session-ID`. Cookie proof тогда не требуется.

## Сессия

После миграции `009_session_lifetime.sql`:

- новая своя сессия живёт 7 суток, демо-сессия — 24 часа;
- старые строки с пустым `expires_at` не удаляются и не считаются истёкшими;
- истёкшая сессия на защищённых маршрутах отвечает `410` и текстом `Session expired. Start a new session.`;
- смена `demo` и `own` у того же UUID отвечает `409` и текстом `Session mode conflict. Start a new session.`;
- `demoStudentId` необязателен. Если он есть, это целое число от 1 до 15, иначе `422`.

Пока миграция 009 не применена, выбор трека сохраняет прежний SQL без колонок срока.

Когда флаг ownership включён, первое создание сессии ставит HttpOnly cookie `vector_session_proof_<uuid без дефисов>`. В JSON и в localStorage proof не передаётся. Чужой или пустой proof даёт `403` `Session ownership verification required`. Без секрета `SESSION_PROOF_SECRET` длиной от 32 байт включённый флаг отвечает `503`.

## Генерация

Повтор с тем же `Idempotency-Key` после обрыва сети (`ECONNABORTED`, timeout) не запускает второй пайплайн. Повтор уже сохранённой или ещё выполняющейся задачи не списывает минутный бюджет. Новый и повторно упавший запуск списывают его. Пустой `graph_profession_id` не заменяется выдуманным UUID: название берётся из каталога, а маршрут без внутреннего UUID хранится с ключом `none`.

| Статус | Когда |
|---|---|
| 201 | Результат сохранён или повторно прочитан |
| 202 | Задача ещё выполняется. Поля: `requestId`, `jobStatus`, `status: "in_progress"`, `retryAfterMs` |
| 409 | Другое тело на тот же ключ, нет диагностики или класса |
| 410 | Сессия истекла |
| 429 | Лимит базы на генерации: текст `Слишком много запросов. Попробуй позже.` и заголовок `Retry-After`. На остальных записях — `details.code` равен `rate_limited` и есть `retryAfterMs` |
| 502 | Пайплайн не сохранил результат. `details.errorCode` один из `pipeline_failed`, `persist_failed`, `incomplete_result`, `attempts_exhausted`, `input_unavailable`, `input_mismatch` |

Текст ошибки модели и ответы ученика в тело и в лог не попадают.

Генерация и создание сессии используют бюджеты PostgreSQL из `origin/main`, а не второй внутрипроцессный счётчик. Иначе класс упёрся бы в пересечение двух лимитов.

- генерация: 30 запросов в минуту на весь процесс базы и 5 запросов в минуту на сессию (`request_budgets`);
- модель: не больше 2 одновременных пайплайнов и 200 запросов в сутки (`ai:global:day`);
- создание сессии: 120 в минуту глобально и 30 в минуту на IP.

Внутрипроцессные лимиты остаются на остальных приватных маршрутах. Их можно поднять переменными окружения. `RATE_LIMIT_DISABLED=true` отключает только их, не бюджеты базы.

- запись: 60 запросов на сессию в минуту (`RATE_LIMIT_WRITES`);
- чтение: 240 запросов на сессию в минуту (`RATE_LIMIT_READS`).

Публичные каталожные GET не ограничены, чтобы общий адрес школы их не блокировал.

## Рефлексия и шаги 1–4

Старый POST без новых полей не меняется: `201` и `{ id, created_at, status: "saved" }`.

Необязательные поля:

- `journeyStep`: целое 1, 2, 3 или 4;
- `stage`: только `final`. Это то же самое, что шаг 4.

Шаг 4 — финальная рефлексия. Для 1–4 класса `recommendationId` не обязателен. Оценка `rating` обязательна и остаётся `useful`, `unsure` или `not_useful`.

Ответ с шагом добавляет `journeyStep`, `stage` (`final` или `progress`) и `ageTier` (`1-4`, `5-8`, `9-11` или `null`, если класс ещё не сохранён). Одновременные `stage: "final"` и `journeyStep` меньше 4 дают `422`.

Чтение отдаёт `journeyStep` и `stage` только у записей, где шаг сохранён. Для этого нужна миграция `011_reflection_journey.sql`. Номер 010 занят `010_request_budgets.sql` из main и не переименовывался. Без миграции 011 старое чтение работает, а запись шага отвечает `503`.

## Health

Поля main сохранены: `revision`, `sessionOwnership`, `generationWorker`, `database`, `service`, `aiConfigured`. Блок `readiness` добавляет `sessionProofEnforced`, `embeddingsConfigured`, `generationWorker: "external-process"`, `rateLimit: "database-budgets-and-per-process"`. Он не доказывает, что модель или семантический индекс ответили. `sessionOwnership` в production равен true даже без отдельного флага.

## Каталог

Источник идентификаторов для приложения — `backend/data/catalog.normalized.json`. PostgreSQL хранит UUID и необязательные `graph_profession_id`, `graph_program_id`, `graph_organization_id`. Отсутствующий graph id не заменяется выдуманным соответствием. Сверка — только чтение, скрипт `scripts/catalog-integrity.mjs`.
