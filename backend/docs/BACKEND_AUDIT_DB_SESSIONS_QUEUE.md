# Аудит DB-связей, сессий, очереди и сохранения

Дата снимка: 2026-11-11. Ветка `fix/backend-integration-stability`.

Проверенный код: локальный HEAD и `origin/fix/backend-integration-stability` равны `3b49aa989a4c256078c6e153569a2dc49eb563b2`. `origin/main` остаётся `c6d992cd02d0b01c14239cfb2f7dde13d99761e8`. Merge с main в этом проходе не делался.

Проверенная база: только `vector_prof_generation_stand`, пользователь `generation_stand`, хост `127.0.0.1:55432`. Внутри контейнера порт 5432. `navigator-postgres` на порту 5433 не открывался. Общий сервер, Railway и production-БД не открывались. Этот документ не описывает production как проверенный.

## 1. Источник истины каталога

Файл `backend/data/navigator_full_graph.json`, схема `hybrid_v2`, версия 1.1. Заголовок `meta.counts`: 11 отраслей, 30 профессий, 39 навыков, 176 связей навык–профессия, 104 организации, 52 программы, 156 связей программа–профессия, 111 проб, 111 связей проба–профессия, 30 снимков вакансий.

`backend/data/catalog.normalized.json` — тот же hybrid_v2, версия `sha256:0eb9dbee78b76f60f593d82332a3220f99966a0c0b7799348a4454bc8a1287a3`. Загрузчик `backend/scripts/sync-hybrid-catalog.mjs` пишет в PostgreSQL из графа. Для организаций, программ и проб он кладёт исходный id и в `external_id`, и в `graph_*_id`. Для профессий INSERT перечисляет `external_id, title, description, industry_id, riasec, demand_level_region, salary_median_region, vacancies_count`. Столбца `graph_profession_id` в этом INSERT нет, и по файлу загрузчика строка `graph_profession_id` не встречается.

Таблица программ называется `education_programs`. Имени `educational_programs` в схеме нет.

## 2. Снимок изолированного стенда

Миграции в `schema_migrations`, по имени файла: `001_initial_schema.sql` … `011_reflection_journey.sql`. Повторно в этом проходе они не применялись. Запросы были только `SELECT`.

| Сущность | Граф `meta.counts` | Строк на стенде | Пустой `graph_*` |
|---|---:|---:|---:|
| industries | 11 | 11 | — |
| professions | 30 | 30 | 30 |
| skills | 39 | 39 | — |
| profession_skills | 176 | 176 | — |
| organizations | 104 | 104 | 0 |
| education_programs | 52 | 52 | 0 |
| program_professions | 156 | 156 | — |
| professional_trials | 111 | 111 | 0 |
| trial_professions | 111 | 111 | — |
| vacancy_snapshots | 30 | 0 | — |

У всех 30 профессий `external_id` заполнен, `graph_profession_id` пуст, `vacancies_count` заполнен. У программ и проб `organization_id` заполнен. Сирот по `program_professions` и `trial_professions` нет. Программ и проб со ссылкой на отсутствующую организацию нет.

`vacancy_snapshots` пуст, потому что загрузчик эту таблицу не пишет. Число вакансий для профессии лежит в `professions.vacancies_count` и в JSON каталога. Пустая таблица снимков не блокирует показ названия и `retrieval_only`.

На стенде также есть синтетические сессии прошлых локальных тестов, не данные школьников: 32 сессии, из них 8 с `expires_at IS NULL`; 3 маршрута, все с `profession_key = 'none'`; 24 задачи (21 `completed`, 3 `failed`); 21 рекомендация; 7 рефлексий, у всех `journey_step IS NULL`. У failed-задач коды `persist_failed` (2) и `pipeline_failed` (1). Это следы стендовых инъекций, не лог общего сервера. Расхождений сессии между `generation_jobs.recommendation_id` и `recommendations` нет. Завершённых задач без рекомендации нет. Рекомендаций без `generation_job_id` нет.

## 3. Как связываются id

Внутренний ключ строк — UUID `professions.id`, `education_programs.id`, `organizations.id`, `professional_trials.id`.

Каталожный id профессии — `professions.external_id` (`prof_00x` в графе). `graph_profession_id` задуман отдельным текстовым ключом с уникальным индексом `professions_graph_profession_id_key`. В PostgreSQL несколько NULL в уникальном индексе допустимы, поэтому 30 пустых значений не нарушают ограничение.

`mapCatalogProfessionId` в `backend/lib/sofi-adapter.ts` считает профессию сопоставленной только если ровно одна строка имеет `graphProfessionId`, равный id из гипотезы, и `id` этой строки — UUID. Иначе статус `unmapped` или `ambiguous`, а `professionId` равен null. При пустом столбце все 30 профессий дают `unmapped`.

Дальше `sofi-generate.ts` берёт `professionId ?? catalogProfessionId` и название из каталога. Рекомендация показывается. UUID профессии при этом не появляется.

`app/page.tsx` ставит `professionKey` в UUID только если выбранный id уже UUID. Иначе ключ `none`. Ограничение `education_routes.profession_key` принимает `none` или UUID. Уникальность `(session_id, profession_key)` даёт один маршрут на сессию для всех несопоставленных профессий. На стенде это видно напрямую: 3 маршрута из 3 имеют ключ `none`.

Соответствия id не выдумывались и в столбец не записывались.

## 4. Миграции 007–011 и старые строки

Все пять миграций аддитивны: новые таблицы или nullable-колонки. Они не переписывают ответы и не удаляют сессии.

- 007 создаёт `generation_jobs` и nullable `recommendations.generation_job_id`. Старая рекомендация без задачи остаётся валидной. Уникальность пары `(session_id, client_request_id)` и уникальность `generation_job_id` не дают вторую рекомендацию на ту же задачу.
- 008 создаёт `education_routes`. До первого сохранения таблица пуста.
- 009 добавляет nullable `session_mode` (`demo`/`own`) и `expires_at`. NULL в `expires_at` — прежняя сессия, не просроченная. Индекс строится только по непустым срокам.
- 010 создаёт `request_budgets` и индекс по уточнениям. Данные сессий не меняет.
- 011 добавляет nullable `journey_step` от 1 до 4. Старая рефлексия без шага остаётся валидной.

Откат релиза не требует `DROP`. Старый код может не читать новые колонки. Удалять их после неудачной выкладки не нужно.

## 5. Сессии и proxy

`X-Session-ID` — публичный UUID-локатор. Его нет: 401 `X-Session-ID header is required`. Не UUID: 400. Сессии нет: 404. Срок вышел: 410. Конфликт `demo`/`own`: 409. Чужой или пустой HMAC при включённой проверке: 403 `Session ownership verification required`. Секрет короче 32 байт при включённой проверке: 503 на выборе трека, потому что выпуск proof падает до записи.

Cookie: имя `vector_session_proof_<uuid без дефисов>`, HttpOnly, `SameSite=strict`, `Path=/`, атрибут `Domain` не задаётся. `Secure` включается только при `NODE_ENV=production`. Свой режим живёт 7 суток (`maxAge`), демо — cookie сессии браузера без `maxAge`. Срок строки: демо 24 часа, свой режим 7 суток. NULL `expires_at` очистка не выбирает.

Проверка включена, когда `NODE_ENV=production` или `SESSION_PROOF_ENFORCED=true`. Cookie ставится в `POST /api/track/select` только если строки сессии ещё не было. Уже существующий UUID без cookie получает 403 и новый proof не выпускается.

Frontend `lib/api.ts` и `lib/demo-backend.ts` передают `X-Session-ID` и не выставляют `credentials`. Для same-origin браузер сам шлёт cookie. Если `NEXT_PUBLIC_API_BASE_URL` указывает на другой origin, cookie на запрос не уйдёт. `next.config.ts` проксирует `/api/:path*` на `BACKEND_INTERNAL_URL` (по умолчанию `http://localhost:3000`) с `proxyTimeout` 120000 мс. При пустом публичном API-base браузер остаётся на origin фронтенда, и cookie host-only совпадает с ним.

Смена origin или хоста API оставляет UUID в `localStorage`/`sessionStorage` и не переносит host-only cookie. При включённой проверке это 403 до новой сессии.

`clientKeyFromHeaders` берёт первый адрес `X-Forwarded-For`, иначе `x-real-ip`. Доверенный список прокси в коде отсутствует. Клиент может подменить первый адрес. Это проверено unit-тестом. Граница production-proxy не проверялась и production-ready не считается.

Лимиты, которые реально стоят в коде:

- генерация: `generate:global` 30 за 60 с, `generate:session:<id>` 5 за 60 с, `ai:global:day` 200 за 86400 с, два advisory-слота пайплайна;
- выбор трека: `sessions:global` 120 за 60 с и `sessions:ip:<bucket>` 30 за 60 с;
- отдельный in-memory лимит создания трека: 180 за 10 минут на хэш первого адреса.

Повтор задачи в статусе `completed`, `pending` или `running` минутный бюджет генерации не списывает. Новый запрос и статус `failed` списывают, потому что пайплайн выполняется снова. Школьный NAT с одним внешним адресом делит IP-лимит выбора трека. Это может остановить новых учеников за одним адресом, не стирая уже созданные сессии.

## 6. Очередь

`Idempotency-Key` — UUID. Пара с сессией уникальна. `input_hash` и `input_snapshot` фиксируются при создании. Повтор с тем же ключом и другим телом даёт конфликт входа, а не вторую задачу.

Статусы: `pending`, `running`, `completed`, `failed`. Аренда `locked_until` на 3 минуты, владелец в `locked_by`. Завершение и провал требуют текущего владельца. Worker выбирает `FOR UPDATE SKIP LOCKED`: живую аренду не забирает, истёкшую может забрать, уже сохранённую рекомендацию присоединяет, не создавая вторую. После 3 попыток код `attempts_exhausted`. Повторно в очередь возвращается только `pipeline_failed`. `persist_failed` не повторяется.

`ECONNABORTED`, `ETIMEDOUT`, `ECONNRESET`, `AbortError` и `TimeoutError` помечаются как транспортный сбой и снаружи становятся `pipeline_failed` с HTTP 502. Два одновременных POST с одним ключом упираются в уникальность и `SKIP LOCKED`. F5 при открытом ключе переиспользует тот же `Idempotency-Key`.

API выполняет генерацию внутри запроса. `npm start` worker не запускает. Внутренний worker стартует только при `NEXT_RUNTIME=nodejs` и `GENERATION_WORKER_ENABLED=true`. Отдельная команда `npm run worker:generation` читает обычный `DATABASE_URL` и настоящий пайплайн. На стенде она не запускалась. Безопасный стендовый worker подменяет пайплайн и отказывается от AI-переменных.

В лог пишутся `requestId`, `errorCode`, длительности `pipeline` и `persist`. Тела ответов ученика, cookie, proof и ключи в эти поля не входят: redact-тест это покрывает. Публичный 502 по логам сервера не подтверждён.

Stub-проверка не вызывает GigaChat и EmbeddingsGigaR. Настоящий клиент без `LLM_BASE_URL`, `LLM_API_KEY` и `LLM_MODEL` выбрасывает ошибку до HTTP и переходит в `retrieval_only`. Эмбеддинг вызывается только при настроенном шлюзе и пригодных векторах. Ожидаемая размерность индекса — 2560, имя модели в контракте — `EmbeddingsGigaR`. Режим `semantic` не ставится, если выполнился только lexical. Кэш рекомендации пишется только для `llm` вместе с `semantic` и живёт один час.

## 7. Сохранение

Ключевая рекомендация вставляется и задача завершается в одной транзакции: `BEGIN`, проверка аренды, `INSERT`, `UPDATE` задачи, `COMMIT`. Ошибка откатывает обе записи. Потеря владельца тоже откатывается. Повтор уникального `generation_job_id` находит уже сохранённую строку и не создаёт вторую. Поэтому текущий код не оставляет состояние «рекомендация записана, задача не завершена». Worker всё равно умеет присоединить такую пару, если она появится у старого кода. На стенде таких пар нет.

`GET /api/session` и `GET /api/recommendations/jobs/:requestId` читают только сессию из заголовка и при включённой проверке требуют её cookie. Чужая сессия не читается.

Маршрут образования хранит `version`. Повтор с устаревшей версией возвращает 409 и текущую серверную строку. Без тела маршрута в 409 интерфейс показывает уведомление. Две кнопки выбора появляются, когда в ответе есть `details.route`. Локальная копия остаётся в storage до явного выбора.

`POST /api/reflection` принимает `journeyStep` 1…4 и `stage: final`. `stage: final` без шага записывает шаг 4. Конфликт шага и `final` отклоняется. Возрастные корзины: 1–4, 5–8, 9–11. Класс 1–4 не требует профессии. Интерфейс `PrimaryExperience.tsx` отправляет `rating` и `comment` и не отправляет `journeyStep` или `stage`. Поэтому серверный столбец остаётся NULL. На стенде все 7 текущих рефлексий имеют пустой шаг. Контракт API шаг поддерживает. Это разрыв клиента и сервера, не потеря уже принятого шага.

Доступ к строкам идёт по `session_id`. Удаление сессии каскадом убирает профиль, диагностику, задачи, маршруты и рефлексии. Рекомендация, на которую ссылается задача, при удалении рекомендации обнуляет ссылку (`ON DELETE SET NULL`), а не чужую сессию.

## 8. Что не проверено

- Ревизия, логи, `schema_migrations` и содержимое рабочей базы.
- Топология proxy и реальное значение `X-Forwarded-For` на сервере.
- Значение `NEXT_PUBLIC_API_BASE_URL`, `SESSION_PROOF_SECRET`, `GENERATION_WORKER_ENABLED` и `NODE_ENV` на сервере.
- Живой вызов GigaChat и EmbeddingsGigaR.
- Причина публичного 502. Локальный `persist_failed` из отвязанного `query` исправлен в `68a9ae1` и повторно пройден стендовым клиентом в `3b49aa9`. Это не доказывает ту же ошибку на сервере.
