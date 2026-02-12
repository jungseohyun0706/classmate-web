import React, { useState } from 'react'
import { initFirebase } from '../../lib/firebase'
import { getAuth, createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { useRouter } from 'next/router'

initFirebase()

export default function RegisterPage(){
  const router = useRouter()
  const [email,setEmail]=useState('')
  const [password,setPassword]=useState('')
  const [displayName,setDisplayName]=useState('')
  const [error,setError]=useState<string|null>(null)
  const [info,setInfo]=useState<string|null>(null)
  const [loading,setLoading]=useState(false)
  const auth = getAuth()

  const onSubmit = async (e:React.FormEvent) =>{
    e.preventDefault()
    setError(null); setInfo(null)
    if(!email || !password){ setError('이메일과 비밀번호를 입력해 주세요.'); return }
    setLoading(true)
    try{
      const cred = await createUserWithEmailAndPassword(auth,email,password)
      const user = cred.user
      // create users doc with role: teacher and schoolId later- filled by admin or from flow
      try{
        const { db } = await import('../../lib/firebase')
        await setDoc(doc(db,'users',user.uid),{
          email: user.email,
          displayName: displayName || null,
          role: 'teacher',
          schoolId: null,
          createdAt: serverTimestamp()
        })
      }catch(e){
        console.warn('users doc write failed',e)
      }
      await sendEmailVerification(user)
      setInfo('가입이 완료되었습니다. 인증 메일을 보냈습니다. 메일을 확인해 주세요.')
      // keep user on page until verify
    }catch(e:any){
      console.error(e)
      setError(e.message || '회원가입에 실패했습니다.')
    }finally{ setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full bg-white p-8 rounded shadow">
        <h1 className="text-2xl font-semibold mb-6">교사용 회원가입</h1>
        {error && <div className="mb-4 text-sm text-red-700 bg-red-50 p-3 rounded">{error}</div>}
        {info && <div className="mb-4 text-sm text-blue-700 bg-blue-50 p-3 rounded">{info}</div>}
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">이름 (선택)</label>
            <input className="mt-1 block w-full border border-gray-300 rounded px-3 py-2" value={displayName} onChange={(e)=>setDisplayName(e.target.value)} placeholder="표시될 이름" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">이메일</label>
            <input type="email" className="mt-1 block w-full border border-gray-300 rounded px-3 py-2" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="학교 이메일" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">비밀번호</label>
            <input type="password" className="mt-1 block w-full border border-gray-300 rounded px-3 py-2" value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="비밀번호 (6자 이상)" />
          </div>
          <button type="submit" disabled={loading} className="w-full bg-indigo-600 text-white py-2 rounded">{loading ? '가입중...' : '회원가입'}</button>
        </form>
        <div className="mt-4 text-sm text-gray-600">가입 후 이메일 인증을 꼭 완료해야 로그인이 가능합니다.</div>
      </div>
    </div>
  )
}
