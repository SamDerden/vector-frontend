'use client';

import React, { useState } from 'react';
import questionsData from '../data/questions.json';

interface Option {
  value: string;
  label: string;
  score: number;
  segment?: string;
}

interface Question {
  question_id: string;
  text: string;
  mechanic: string;
  options?: Option[];
  target_construct: string;
}

interface RIASECTestProps {
  onScoreCalculate: (constructScores: { [key: string]: number }) => void;
}

export default function RIASECTest({ onScoreCalculate }: RIASECTestProps) {
  // Фильтруем только вопросы, которые относятся к шкалам RIASEC
  const diagnosticQuestions = (questionsData.questions as Question[]).filter(q => 
    ['riasec_r', 'riasec_i', 'riasec_a', 'riasec_s', 'riasec_e', 'riasec_c'].includes(q.target_construct)
  );

  // Состояние ответов на вопросы: { [question_id]: score }
  const [userAnswers, setUserAnswers] = useState<{ [key: string]: number }>({});

  const handleSelectOption = (questionId: string, targetConstruct: string, score: number) => {
    const updatedAnswers = { ...userAnswers, [questionId]: score };
    setUserAnswers(updatedAnswers);

    // Расчет средних баллов по каждой шкале RIASEC
    const sums: { [key: string]: number } = {};
    const counts: { [key: string]: number } = {};

    diagnosticQuestions.forEach(q => {
      const ansVal = updatedAnswers[q.question_id];
      if (ansVal !== undefined) {
        const key = q.target_construct.replace('riasec_', '').toUpperCase(); // Получаем 'R', 'I', 'A'...
        sums[key] = (sums[key] || 0) + ansVal;
        counts[key] = (counts[key] || 0) + 1;
      }
    });

    const finalScores: { [key: string]: number } = {
      R: 0.5, I: 0.5, A: 0.5, S: 0.5, E: 0.5, C: 0.5
    };
    
    Object.keys(sums).forEach(key => {
      // Приводим балл к шкале от 0 до 1
      finalScores[key] = sums[key] / (counts[key] * 2); // так как максимальный балл в опциях обычно 2
    });

    onScoreCalculate(finalScores);
  };

  return (
    <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', maxHeight: '680px', overflowY: 'auto' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginBottom: '12px', borderBottom: '2px solid #e5e7eb', paddingBottom: '8px' }}>
        🎯 1. Интерактивная диагностика
      </h2>
      <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
        Ответь на вопросы ниже. Твои ответы автоматически пересчитают процент совпадения со всеми 40 профессиями!
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {diagnosticQuestions.map((q, index) => {
          const currentAnswer = userAnswers[q.question_id];
          return (
            <div key={q.question_id} style={{ borderBottom: '1px solid #f3f4f6', paddingBottom: '14px' }}>
              <h4 style={{ fontSize: '14px', fontWeight: '600', color: '#374151', marginBottom: '10px' }}>
                {index + 1}. {q.text}
              </h4>
              
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {q.options?.map(opt => {
                  const isSelected = currentAnswer === opt.score;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => handleSelectOption(q.question_id, q.target_construct, opt.score)}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        border: isSelected ? '1px solid #2563eb' : '1px solid #d1d5db',
                        backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                        color: isSelected ? '#1e40af' : '#4b5563',
                        fontWeight: isSelected ? 'bold' : 'normal'
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
