import React, {useEffect} from 'react'
import {useRouter} from 'next/router'
import {auth, db} from '../../lib/firebase'
import {onAuthStateChanged} from 'firebase/auth'
import {doc, getDoc} from 'firebase/firestore'

export default function AdminPage(){
  const router = useRouter()
  useEffect(()=>{
    const unsub = onAuthStateChanged(auth, async user=>{
      if(!user){ router.push('/auth/login'); return }
      if(!user.emailVerified){ router.push('/auth/verify-email'); return }
      const snap = await getDoc(doc(db,'users',user.uid))
      const data = snap.exists()? snap.data() : null
      if(!data || data.role !== 'admin'){
        router.push('/auth/login')
      }
    })
    return ()=>unsub()
  },[])
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>
      <p className="mt-4">요약 카드 및 사용자 관리 링크</p>
      <ul className="mt-6">
        <li><a href="/admin/users" className="text-blue-600 underline">사용자 관리</a></li>
      </ul>
    </div>
  )
}
