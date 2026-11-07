/** Portrait filenames follow public/assets/children/portrait_mapping.csv.
 * ID and grade are aligned to backend/data/mock_students_data.json.
 * The source of truth for questionnaires and responses remains the backend. */
export const demoProfiles = [
  {
    "id": 1,
    "name": "Аня",
    "grade": 2,
    "group": "1–4",
    "interests": [
      "Животные",
      "Рисование"
    ],
    "avatar": "/assets/children/01_Anya.png"
  },
  {
    "id": 2,
    "name": "Миша",
    "grade": 4,
    "group": "1–4",
    "interests": [
      "Конструкторы",
      "Природа"
    ],
    "avatar": "/assets/children/02_Misha.png"
  },
  {
    "id": 3,
    "name": "Соня",
    "grade": 6,
    "group": "5–8",
    "interests": [
      "Чтение",
      "Музыка"
    ],
    "avatar": "/assets/children/03_Sonya.png"
  },
  {
    "id": 4,
    "name": "Егор",
    "grade": 6,
    "group": "5–8",
    "interests": [
      "Спорт",
      "Техника"
    ],
    "avatar": "/assets/children/04_Egor.png"
  },
  {
    "id": 5,
    "name": "Вика",
    "grade": 7,
    "group": "5–8",
    "interests": [
      "Видео",
      "Помощь другим"
    ],
    "avatar": "/assets/children/05_Vika.png"
  },
  {
    "id": 6,
    "name": "Даня",
    "grade": 7,
    "group": "5–8",
    "interests": [
      "Программирование",
      "Игры"
    ],
    "avatar": "/assets/children/06_Danya.png"
  },
  {
    "id": 7,
    "name": "Полина",
    "grade": 8,
    "group": "5–8",
    "interests": [
      "Дизайн",
      "Фотография"
    ],
    "avatar": "/assets/children/07_Polina.png"
  },
  {
    "id": 8,
    "name": "Артём",
    "grade": 8,
    "group": "5–8",
    "interests": [
      "Анализ данных",
      "Стратегии"
    ],
    "avatar": "/assets/children/08_Artem.png"
  },
  {
    "id": 9,
    "name": "Настя",
    "grade": 9,
    "group": "9–11",
    "interests": [
      "Вокал",
      "Театр"
    ],
    "avatar": "/assets/children/09_Nastya.png"
  },
  {
    "id": 10,
    "name": "Илья",
    "grade": 9,
    "group": "9–11",
    "interests": [
      "Наука",
      "Изобретения"
    ],
    "avatar": "/assets/children/10_Ilya.png"
  },
  {
    "id": 11,
    "name": "Саша",
    "grade": 9,
    "group": "9–11",
    "interests": [
      "IT и технологии",
      "Стартапы"
    ],
    "avatar": "/assets/children/11_Sasha.png"
  },
  {
    "id": 12,
    "name": "Кира",
    "grade": 10,
    "group": "9–11",
    "interests": [
      "Маркетинг",
      "Проекты"
    ],
    "avatar": "/assets/children/12_Kira.png"
  },
  {
    "id": 13,
    "name": "Максим",
    "grade": 10,
    "group": "9–11",
    "interests": [
      "Инженерия",
      "Авто"
    ],
    "avatar": "/assets/children/13_Maksim.png"
  },
  {
    "id": 14,
    "name": "Лиза",
    "grade": 11,
    "group": "9–11",
    "interests": [
      "Графика",
      "Кино"
    ],
    "avatar": "/assets/children/14_Liza.png"
  },
  {
    "id": 15,
    "name": "Роман",
    "grade": 11,
    "group": "9–11",
    "interests": [
      "Бизнес",
      "Путешествия"
    ],
    "avatar": "/assets/children/15_Roman.png"
  }
] as const;
