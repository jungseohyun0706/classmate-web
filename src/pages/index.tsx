import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'

export default function Home() {
  const router = useRouter()
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user && user.emailVerified) {
        router.replace('/dashboard')
      } else {
        router.replace('/auth/login')
      }
    })
    return () => unsub()
  }, [])
  return null
}
