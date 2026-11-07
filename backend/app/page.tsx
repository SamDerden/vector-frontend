'use client';

import React, { useState, useEffect } from 'react';
import RIASECTest from '../components/RIASECTest';
import ProfessionDetails from '../components/ProfessionDetails';

interface Question {
  question_id: string;
  text: string;
  mechanic: string;
  options?: { value: string; label: string; score?: number; allow_custom?: boolean }[];
}

interface ClarificationQuestion {
  question_id: string;
  text: string;
  options: { value: string; label: string; allow_custom?: boolean }[];
}

export default function Home() {
  // Сессия и состояние интерфейса
  const [sessionId, setSessionId] = useState<string>('');
  const [step, setStep] = useState<number>(1); // 1: Выбор трека, 2: Анкета, 3: Уточнения, 4: Результаты ИИ
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Шаг 1: Выбор трека
  const [trackType, setTrackType] = useState<string>('interests');
  const [schoolGrade, setSchoolGrade] = useState<number>(7);
  const [confidenceBefore, setConfidenceBefore] = useState<string>('medium');

  // Шаг 2: Анкета
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<{ [key: string]: any }>({});

  // Шаг 3: Уточняющие вопросы
  const [clarificationQuestions, setClarificationQuestions] = useState<ClarificationQuestion[]>([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<{ [key: string]: { values: string[]; customText?: string } }>({});

  // Шаг 4: Результаты ИИ
  const [recommendations, setRecommendations] = useState<any>(null);
  const [selectedProfession, setSelectedProfession] = useState<any>(null);
  const [reflectionRating, setReflectionRating] = useState<string>('useful');
  const [reflectionComment, setReflectionComment] = useState<string>('');
  const [reflectionSaved, setReflectionSaved] = useState<boolean>(false);

  // Функция маппинга системных ошибок
  const getFriendlyErrorMessage = (status: number, defaultText: string) => {
    switch (status) {
      case 400:
        return 'Проверить идентификатор сессии или формат запроса';
      case 401:
        return 'На запрос не попал X-Session-ID';
      case 404:
        return 'Сессия, диагностика или рекомендация не найдены.';
      case 409:
        return 'Не хватает класса или ещё не отправлена диагностика';
      case 422:
        return 'Ответ не из списка или класс вне диапазона 1–11';
      case 502:
        return 'Генерация не сохранилась (ошибка AI-сервиса)';
      case 503:
        return 'Сервер или схема базы данных временно недоступны';
      default:
        return defaultText;
    }
  };

  // Инициализация Session UUID и восстановление сессии
  useEffect(() => {
    let sid = localStorage.getItem('X-Session-ID');
    if (!sid) {
      sid = crypto.randomUUID();
      localStorage.setItem('X-Session-ID', sid);
    }
    setSessionId(sid);
    restoreSession(sid);
  }, []);

  // Метод восстановления сессии
  const restoreSession = async (sid: string) => {
    try {
      const res = await fetch('/api/session', {
        headers: {
          'X-Session-ID': sid,
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.schoolGrade) setSchoolGrade(data.schoolGrade);
        if (data.trackType) setTrackType(data.trackType);
        if (data.recommendation) {
          setRecommendations(data.recommendation);
          setStep(4);
        } else if (data.diagnostic) {
          await loadClarificationQuestions(sid);
          setStep(3);
        } else if (data.trackType) {
          await loadDiagnosticQuestions(data.schoolGrade || 7);
          setStep(2);
        }
      }
    } catch (err) {
      console.error('Не удалось восстановить сессию', err);
    }
  };

  // Выбор трека и класса
  const handleTrackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); 
    setError(null);
    try {
      const res = await fetch('/api/track/select', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({ trackType, schoolGrade, confidenceBefore }),
      });
      if (!res.ok) {
        throw new Error(getFriendlyErrorMessage(res.status, 'Ошибка при сохранении трека'));
      }
      await loadDiagnosticQuestions(schoolGrade);
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Загрузка вопросов анкеты
  const loadDiagnosticQuestions = async (grade: number) => {
    const res = await fetch(`/api/diagnostic/questions?grade=${grade}`);
    if (!res.ok) throw new Error('Не удалось загрузить диагностические вопросы');
    const data = await res.json();
    setQuestions(data.questions || []);
  };

  // Выбор ответа на обычные вопросы анкеты
  const handleAnswerSelect = (qId: string, val: string) => {
    setAnswers(prev => {
      const current = prev[qId] || [];
      const updated = current.includes(val)
        ? current.filter((item: string) => item !== val)
        : [...current, val];
      return { ...prev, [qId]: updated };
    });
  };

  // Коллбек калькуляции RIASECTest
  const handleRIASECCalculate = (scores: { [key: string]: number }) => {
    setAnswers(prev => ({
      ...prev,
      riasec_scores: scores
    }));
  };

  // Отправка анкеты
  const handleDiagnosticSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      const formattedAnswers = Object.keys(answers).map(key => ({
        questionId: key,
        answer: answers[key]
      }));

      const res = await fetch('/api/diagnostic/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({ answers: formattedAnswers }),
      });
      if (!res.ok) {
        throw new Error(getFriendlyErrorMessage(res.status, 'Ошибка отправки диагностической анкеты'));
      }
      
      // Загружаем уточнения
      await loadClarificationQuestions(sessionId);
      setStep(3);
    } catch (err: any) { 
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Загрузка 6 уточняющих вопросов
  const loadClarificationQuestions = async (sid: string) => {
    const res = await fetch('/api/clarification/questions', {
      headers: {
        'X-Session-ID': sid,
      }
    });
    if (!res.ok) throw new Error('Не удалось загрузить уточняющие вопросы');
    const data = await res.json();
    setClarificationQuestions(data.questions || []);
  };

  // Изменение уточняющего ответа
  const handleClarificationChange = (qId: string, val: string, isCheckbox: boolean = true) => {
    setClarificationAnswers(prev => {
      const current = prev[qId] || { values: [] };
      let updatedValues: string[];
      if (isCheckbox) {
        updatedValues = current.values.includes(val)
          ? current.values.filter(v => v !== val)
          : [...current.values, val];
      } else {
        updatedValues = [val];
      }
      return {
        ...prev,
        [qId]: { ...current, values: updatedValues }
      };
    });
  };

  const handleClarificationCustomText = (qId: string, text: string) => {
    setClarificationAnswers(prev => {
      const current = prev[qId] || { values: [] };
      return {
        ...prev,
        [qId]: { ...current, customText: text }
      };
    });
  };

  // Отправка уточнений
  const handleClarificationSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      const formatted = Object.keys(clarificationAnswers).map(key => {
        const data = clarificationAnswers[key];
        if (data.values.includes('other')) {
          return {
            questionId: key,
            answer: {
              values: data.values,
              customText: data.customText || ''
            }
          };
        } else {
          return {
            questionId: key,
            answer: data.values.length === 1 ? data.values[0] : data.values
          };
        }
      });

      const res = await fetch('/api/clarification/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({ answers: formatted }),
      });

      if (!res.ok) {
        throw new Error(getFriendlyErrorMessage(res.status, 'Ошибка отправки уточняющих ответов'));
      }

      // Запускаем расчет рекомендаций Софи ИИ
      await generateRecommendations();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Генерация рекомендаций
  const generateRecommendations = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/recommendations/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        throw new Error(getFriendlyErrorMessage(res.status, 'Не удалось сгенерировать рекомендации'));
      }
      const data = await res.json();
      setRecommendations(data);
      setStep(4);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Сохранение рефлексии
  const handleSaveReflection = async () => {
    if (!recommendations) return;
    try {
      const res = await fetch('/api/reflection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({
          rating: reflectionRating,
          comment: reflectionComment,
          recommendationId: recommendations.recommendationId
        })
      });
      if (res.ok) {
        setReflectionSaved(true);
      } else {
        throw new Error(getFriendlyErrorMessage(res.status, 'Ошибка сохранения рефлексии'));
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px', fontFamily: 'system-ui, sans-serif', color: '#1f2937', backgroundColor: '#f9fafb', minHeight: '100vh' }}>
      <header style={{ textAlign: 'center', marginBottom: '40px' }}>
        <h1 style={{ fontSize: '36px', fontWeight: '800', color: '#1e3a8a', marginBottom: '8px' }}>🧭 Профессиональный Навигатор</h1>
        <p style={{ fontSize: '18px', color: '#4b5563' }}>Ваш интеллектуальный гид по карьерному росту со встроенным AI-ассистентом Sofi</p>
        <span style={{ fontSize: '12px', background: '#e5e7eb', padding: '4px 10px', borderRadius: '20px', display: 'inline-block', marginTop: '10px' }}>Сессия: {sessionId}</span>
      </header>

      {error && (
        <div style={{ padding: '16px', backgroundColor: '#fee2e2', borderLeft: '4px solid #ef4444', borderRadius: '6px', color: '#991b1b', marginBottom: '24px' }}>
          ⚠️ <strong>Внимание:</strong> {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px' }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#2563eb', marginBottom: '12px' }}>
            🔄 Софи ИИ рассчитывает ваш вектор развития...
          </div>
          <p style={{ color: '#4b5563', fontSize: '15px' }}>Обычно это занимает около 8-12 секунд. Пожалуйста, не закрывайте вкладку.</p>
        </div>
      )}

      {!loading && (
        <main>
          {/* Шаг 1: Выбор класса и трека */}
          {step === 1 && (
            <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '32px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', maxWidth: '600px', margin: '0 auto' }}>
              <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#111827', marginBottom: '20px', textAlign: 'center' }}>👋 Начнем твое исследование</h2>
              <form onSubmit={handleTrackSubmit}>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontWeight: '600', marginBottom: '8px' }}>Выбери свой класс:</label>
                  <input
                    type="number"
                    min="1"
                    max="11"
                    value={schoolGrade}
                    onChange={(e) => setSchoolGrade(parseInt(e.target.value))}
                    style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px' }}
                    required
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontWeight: '600', marginBottom: '8px' }}>Выбери трек обучения:</label>
                  <select
                    value={trackType}
                    onChange={(e) => setTrackType(e.target.value)}
                    style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#fff' }}
                  >
                    <option value="explore">🧭 Свободное исследование новых сфер (1-4 класс)</option>
                    <option value="interests">❤️ Определение по интересам и хобби (5-8 класс)</option>
                    <option value="known_direction">🎯 Развитие конкретного направления (9-11 класс)</option>
                  </select>
                </div>

                <div style={{ marginBottom: '30px' }}>
                  <label style={{ display: 'block', fontWeight: '600', marginBottom: '8px' }}>Насколько ты уверен в своем будущем выборе?</label>
                  <select
                    value={confidenceBefore}
                    onChange={(e) => setConfidenceBefore(e.target.value)}
                    style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#fff' }}
                  >
                    <option value="low">Совсем не уверен</option>
                    <option value="medium">Есть пара вариантов</option>
                    <option value="high">Точно знаю, кем хочу быть</option>
                  </select>
                </div>

                <button
                  type="submit"
                  style={{ width: '100%', padding: '12px', backgroundColor: '#2563eb', color: '#fff', fontSize: '16px', fontWeight: '600', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Перейти к диагностике →
                </button>
              </form>
            </section>
          )}

          {/* Шаг 2: Диагностика */}
          {step === 2 && (
            <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '32px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
              <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#111827', marginBottom: '20px' }}>📝 Шаг 2. Заполнение анкеты и RIASEC диагностика</h2>

              <div style={{ marginBottom: '40px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '16px', color: '#1e3a8a' }}>Вопросы по школьным интересам:</h3>
                {questions.map((q) => (
                  <div key={q.question_id} style={{ marginBottom: '24px', padding: '16px', border: '1px solid #f3f4f6', borderRadius: '8px', backgroundColor: '#fafafa' }}>
                    <p style={{ fontWeight: '600', marginBottom: '12px' }}>{q.text}</p>
                    {q.options && q.options.map((opt) => {
                      const isChecked = answers[q.question_id]?.includes(opt.value) || false;
                      return (
                        <label key={opt.value} style={{ display: 'block', margin: '8px 0', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleAnswerSelect(q.question_id, opt.value)}
                            style={{ marginRight: '8px' }}
                          />
                          {opt.label}
                        </label>
                      );
                    })} 
                  </div>
                ))}
              </div>

              <div style={{ borderTop: '2px dashed #e5e7eb', paddingTop: '30px', marginBottom: '30px' }}>
                <RIASECTest onScoreCalculate={handleRIASECCalculate} />
              </div>

              <button
                onClick={handleDiagnosticSubmit}
                style={{ width: '100%', padding: '14px', backgroundColor: '#10b981', color: '#fff', fontSize: '18px', fontWeight: '600', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
              >
                Отправить ответы и перейти к уточнениям ➔
              </button>
            </section>
          )}

          {/* Шаг 3: Уточняющие вопросы */}
          {step === 3 && (
            <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '32px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', maxWidth: '800px', margin: '0 auto' }}>
              <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#111827', marginBottom: '12px' }}>🔍 Шаг 3. Уточняющие вопросы</h2>
              <p style={{ color: '#4b5563', marginBottom: '24px' }}>Эти 6 вопросов помогут Sofi ИИ максимально детально составить план развития.</p>

              {clarificationQuestions.map((cq) => {
                const ansObj = clarificationAnswers[cq.question_id] || { values: [] };
                return (
                  <div key={cq.question_id} style={{ marginBottom: '24px', padding: '20px', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
                    <p style={{ fontWeight: '600', marginBottom: '12px' }}>{cq.text}</p>
                    {cq.options.map((opt) => {
                      const isSel = ansObj.values.includes(opt.value);
                      return (
                        <div key={opt.value} style={{ marginBottom: '8px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => handleClarificationChange(cq.question_id, opt.value)}
                              style={{ marginRight: '8px' }}
                            />
                            {opt.label}
                          </label>
                          {opt.value === 'other' && isSel && (
                            <input
                              type="text"
                              placeholder="Введите ваш вариант..."
                              value={ansObj.customText || ''}
                              onChange={(e) => handleClarificationCustomText(cq.question_id, e.target.value)}
                              style={{ display: 'block', width: '100%', marginTop: '8px', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <button
                onClick={handleClarificationSubmit}
                style={{ width: '100%', padding: '14px', backgroundColor: '#2563eb', color: '#fff', fontSize: '18px', fontWeight: '600', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
              >
                Получить персональные рекомендации ✨
              </button>
            </section>
          )}

          {/* Шаг 4: Результаты */}
          {step === 4 && recommendations && (
            <div>
              {/* Warnings от ИИ */}
              {recommendations.warnings && recommendations.warnings.length > 0 && (
                <div style={{ padding: '12px 18px', backgroundColor: '#fffbeb', borderLeft: '4px solid #f59e0b', borderRadius: '6px', color: '#b45309', marginBottom: '24px', fontSize: '14px' }}>
                  ⚠️ <strong>Уведомление системы:</strong> {recommendations.warnings.join(', ')}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '30px' }}>
                <div>
                  {/* Сводка */}
                  <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginBottom: '24px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1e3a8a', marginBottom: '12px' }}>📋 Анализ интересов</h2>
                    <p style={{ lineHeight: '1.6', color: '#374151' }}>{recommendations.summary}</p>
                    
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
                      {recommendations.interestTags?.map((tag: string, index: number) => (
                        <span key={index} style={{ padding: '4px 12px', backgroundColor: '#eff6ff', color: '#1d4ed8', borderRadius: '15px', fontSize: '13px', fontWeight: '500' }}>
                          🏷️ {tag}
                        </span>
                      ))}
                    </div>
                  </section>

                  {/* Гипотезы профессий */}
                  {schoolGrade >= 5 ? (
                    <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
                      <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginBottom: '8px' }}>🔮 Рекомендованные ИИ профессии</h2>
                      <p style={{ color: '#6b7280', marginBottom: '16px', fontSize: '13px' }}>Выберите профессию, чтобы увидеть подробную карту и шаги развития.</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {recommendations.hypotheses?.map((hyp: any, index: number) => (
                          <div
                            key={index}
                            onClick={() => setSelectedProfession(hyp)}
                            style={{
                              padding: '16px',
                              border: '2px solid',
                              borderColor: selectedProfession?.profession_id === hyp.professionId ? '#2563eb' : '#e5e7eb',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              transition: '0.2s',
                              backgroundColor: selectedProfession?.profession_id === hyp.professionId ? '#f0f6ff' : '#fff'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <h4 style={{ fontWeight: 'bold', fontSize: '16px', color: '#1e3a8a', margin: 0 }}>{hyp.title || hyp.name}</h4>
                              <span style={{ fontSize: '12px', background: '#3b82f6', color: '#fff', padding: '2px 8px', borderRadius: '10px' }}>
                                Ранг: {hyp.fitScore}
                              </span>
                            </div>
                            <p style={{ fontSize: '13px', color: '#4b5563', margin: '8px 0 0 0' }}>{hyp.reason}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : (
                    <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
                      <p style={{ color: '#4b5563', fontStyle: 'italic', textAlign: 'center' }}>
                        👶 Для учеников 1–4 классов детальные гипотезы профессий скрыты. Ориентируйтесь на ваши интересы.
                      </p>
                    </section>
                  )}
                </div>

                <div>
                  {selectedProfession && <ProfessionDetails selectedProfession={selectedProfession} />}

                  {/* Развивающие шаги */}
                  <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginTop: '24px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginBottom: '16px' }}>🚀 Траектории образования и кружки</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      {recommendations.nextStepOptions?.map((opt: any, index: number) => (
                        <div key={index} style={{ padding: '16px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: opt.available ? '#fdfdfd' : '#f3f4f6' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <strong style={{ fontSize: '15px', color: '#111827' }}>
                              {opt.type === 'college' ? '🏫 Колледж/Вуз' : opt.type === 'club' ? '🎨 Кружок' : '💻 Онлайн-курс'}
                            </strong>
                            <span style={{ fontSize: '12px', color: opt.available ? '#16a34a' : '#ef4444', fontWeight: 'bold' }}>
                              {opt.available ? 'Доступно' : 'Недоступно'}
                            </span>
                          </div>
                          {opt.available ? (
                            <div>
                              <h4 style={{ fontWeight: '600', color: '#2563eb' }}>{opt.title}</h4>
                              <p style={{ fontSize: '13px', color: '#4b5563', margin: '4px 0' }}>Организация: {opt.organization}</p>
                              {opt.url && <a href={opt.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', fontSize: '13px', textDecoration: 'underline' }}>Перейти на сайт</a>}
                            </div>
                          ) : (
                            <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>{opt.note}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Оценка и Рефлексия */}
                  <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginTop: '24px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginBottom: '12px' }}>💭 Оценка и рефлексия</h2>
                    {!reflectionSaved ? (
                      <div>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Ваша оценка:</label>
                        <select
                          value={reflectionRating}
                          onChange={(e) => setReflectionRating(e.target.value)}
                          style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px', backgroundColor: '#fff' }}
                        >
                          <option value="useful">👍 Полезно / Хочу попробовать</option>
                          <option value="unsure">🤔 Затрудняюсь ответить</option>
                          <option value="not_useful">👎 Не подходит</option>
                        </select>

                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Комментарий:</label>
                        <textarea
                          value={reflectionComment}
                          onChange={(e) => setReflectionComment(e.target.value)}
                          placeholder="Что вам понравилось или чего не хватило?"
                          style={{ width: '100%', height: '100px', padding: '12px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px', fontFamily: 'inherit' }}
                        />
                        <button
                          onClick={handleSaveReflection}
                          style={{ padding: '10px 20px', backgroundColor: '#1e3a8a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}
                        >
                          Отправить оценку
                        </button>
                      </div>
                    ) : (
                      <div style={{ color: '#16a34a', fontWeight: '600', padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '6px', textAlign: 'center' }}>
                        ✅ Большое спасибо за отзыв! Ваша оценка сохранена.
                      </div>
                    )}
                  </section>

                  {/* Дисклеймер */}
                  {recommendations.disclaimer && (
                    <div style={{ marginTop: '24px', fontSize: '11px', color: '#9ca3af', textAlign: 'center', lineHeight: '1.4' }}>
                      {recommendations.disclaimer}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
