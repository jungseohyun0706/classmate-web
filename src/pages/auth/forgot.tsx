import React, { useState } from 'react'
import { initFirebase } from '../../lib/firebase'
import { getAuth, sendPasswordResetEmail } from 'firebase/auth'

initFirebase()

export default function ForgotPage(){
  const [email,setEmail]=useState('')
  const [info,setInfo]=useState<string|null>(null)
  const [error,setError]=useState<string|null>(null)
  const [loading,setLoading]=useState(false)
  const auth = getAuth()

  const onSubmit = async (e:React.FormEvent)=>{
    e.preventDefault()
    setError(null); setInfo(null)
    if(!email){ setError('이메일을 입력해 주세요.'); return }
    setLoading(true)
    try{
      await sendPasswordResetEmail(auth,email)
      setInfo('비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.')
    }catch(e:any){
      console.error(e)
      setError('비밀번호 재설정 요청에 실패했습니다. 이메일을 확인해 주세요.')
    }finally{ setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full bg-white p-8 rounded shadow">
        <h1 className="text-2xl font-semibold mb-6">비밀번호 재설정</h1>
        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 p-3 rounded">{error}</div>}
        {info && <div className="mb-4 text-sm text-blue-700 bg-blue-50 p-3 rounded">{info}</div>}
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">이메일</label>
            <input type="email" className="mt-1 block w-full border border-gray-300 rounded px-3 py-2" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="가입한 이메일" />
          </div>
          <button type="submit" disabled={loading} className="w-full bg-indigo-600 text-white py-2 rounded">{loading ? '전송중...' : '비밀번호 재설정 메일 보내기'}</button>
        </form>
      </div>
    </div>
  )
}
