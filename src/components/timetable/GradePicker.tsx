import type { JSX } from 'react'

/**
 * 대상 학년(1~6) 여러 개 고르기 — 교사 수업 만들기·정보 수정(선택 항목).
 * 학생 '수업 담기'는 기본으로 내 학년 수업만 보여 주고, 대상 학년을 정하지 않은 수업은 모든 학년에 보여요.
 */
export const GRADE_CHOICES = [1, 2, 3, 4, 5, 6] as const

export function toggleGrade(list: number[], g: number): number[] {
  const set = new Set(list)
  if (set.has(g)) set.delete(g)
  else set.add(g)
  return Array.from(set).sort((a, b) => a - b)
}

export default function GradePicker({
  value,
  onChange,
  name,
  disabled,
}: {
  value: number[]
  onChange: (next: number[]) => void
  /** 같은 화면에 둘 이상일 때 구분(접근성 이름에 쓰지 않음) */
  name: string
  disabled?: boolean
}): JSX.Element {
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold">대상 학년(선택)</legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {GRADE_CHOICES.map((g) => {
          const on = value.includes(g)
          return (
            <label
              key={g}
              className={`inline-flex min-h-[44px] min-w-[3.5rem] cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 font-semibold transition-colors focus-within:ring-2 focus-within:ring-blue-400 ${
                on ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                name={`${name}-grade`}
                className="h-4 w-4"
                checked={on}
                disabled={disabled}
                onChange={() => onChange(toggleGrade(value, g))}
              />
              {g}학년
            </label>
          )
        })}
      </div>
      <span className="mt-1 block text-xs text-gray-500 break-keep">
        학생 &lsquo;수업 담기&rsquo;에서 이 학년 학생에게 먼저 보여요. 고르지 않으면 모든 학년에 보여요.
      </span>
    </fieldset>
  )
}
