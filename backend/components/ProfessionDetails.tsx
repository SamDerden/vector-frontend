'use client';

import React from 'react';

interface Skill {
  skill_id: string;
  name: string;
  type: string;
}

interface Trial {
  trial_id: string;
  title: string;
  organization: string;
  format: string;
  description: string;
}

interface Profession {
  profession_id: string;
  name: string;
  industry: string;
  description_for_kid: string;
  current_market_state: {
    demand_level: string;
    salary_median_rub: number;
  };
  skills: Skill[];
  trials: Trial[];
}

interface ProfessionDetailsProps {
  selectedProfession: Profession | null;
}

export default function ProfessionDetails({ selectedProfession }: ProfessionDetailsProps) {
  return (
    <section style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginBottom: '16px', borderBottom: '2px solid #e5e7eb', paddingBottom: '8px' }}>
        🔍 3. Детали профессии
      </h2>

      {selectedProfession ? (
        <div>
          <h3 style={{ fontSize: '22px', fontWeight: 'bold', color: '#1e3a8a', marginBottom: '6px' }}>{selectedProfession.name}</h3>
          <p style={{ display: 'inline-block', backgroundColor: '#f3f4f6', padding: '4px 8px', borderRadius: '4px', fontSize: '13px', color: '#4b5563', marginBottom: '16px' }}>
            {selectedProfession.industry}
          </p>

          <div style={{ backgroundColor: '#f0fdf4', borderLeft: '4px solid #16a34a', padding: '12px', borderRadius: '4px', marginBottom: '16px' }}>
            <h5 style={{ fontWeight: 'bold', color: '#14532d', fontSize: '14px', marginBottom: '4px' }}>Простыми словами:</h5>
            <p style={{ color: '#166534', fontSize: '14px', fontStyle: 'italic' }}>"{selectedProfession.description_for_kid}"</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '10px' }}>
              <span style={{ fontSize: '12px', color: '#6b7280', display: 'block' }}>Востребованность</span>
              <span style={{ fontWeight: 'bold', color: '#111827' }}>{selectedProfession.current_market_state?.demand_level || 'Неизвестно'}</span>
            </div>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '10px' }}>
              <span style={{ fontSize: '12px', color: '#6b7280', display: 'block' }}>Медианная зарплата</span>
              <span style={{ fontWeight: 'bold', color: '#111827' }}>
                {selectedProfession.current_market_state?.salary_median_rub ? `${selectedProfession.current_market_state.salary_median_rub.toLocaleString()} ₽` : 'не указана'}
              </span>
            </div>
          </div>

          {/* Навыки */}
          <div style={{ marginBottom: '16px' }}>
            <h5 style={{ fontWeight: 'bold', color: '#374151', fontSize: '14px', marginBottom: '6px' }}>Необходимые навыки:</h5>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {selectedProfession.skills?.map(s => (
                <span 
                  key={s.skill_id} 
                  style={{
                    fontSize: '11px', 
                    padding: '4px 8px', 
                    borderRadius: '4px', 
                    backgroundColor: s.type === 'hard' ? '#fee2e2' : '#fef3c7', 
                    color: s.type === 'hard' ? '#991b1b' : '#92400e'
                  }}
                >
                  {s.name} ({s.type})
                </span>
              )) || 'Список пуст'}
            </div>
          </div>

          {/* Профпробы */}
          <div>
            <h5 style={{ fontWeight: 'bold', color: '#374151', fontSize: '14px', marginBottom: '6px' }}>Доступные профпробы:</h5>
            {selectedProfession.trials && selectedProfession.trials.length > 0 ? (
              selectedProfession.trials.map(t => (
                <div key={t.trial_id} style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '10px', backgroundColor: '#fafafa' }}>
                  <strong style={{ fontSize: '13px', color: '#111827' }}>{t.title}</strong>
                  <div style={{ fontSize: '12px', color: '#4b5563', margin: '2px 0' }}>Организатор: {t.organization} ({t.format})</div>
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: '0' }}>{t.description}</p>
                </div>
              ))
            ) : (
              <p style={{ fontSize: '13px', color: '#9ca3af' }}>Для этой профессии пока нет активных профессиональных проб.</p>
            )}
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '40px 0' }}>
          <p style={{ fontSize: '16px' }}>👈 Выберите профессию из каталога слева, чтобы открыть полную информацию.</p>
        </div>
      )}
    </section>
  );
}
