import { useEffect } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { normalizeWeeklySchedule } from '../lib/timetableConvert'

interface NativeReceiver {
  postMessage: (message: object) => void
}

export default function IOSScheduleBridge() {
  useEffect(() => {
    const host = window as Window & { webkit?: { messageHandlers?: { schedule?: NativeReceiver } } }
    const receiver = host.webkit?.messageHandlers?.schedule
    if (!receiver || !auth || !db) return
    let stopProfile: Unsubscribe | undefined
    let stopSchedule: Unsubscribe | undefined
    const clear = () => receiver.postMessage({ signedOut: true })
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stopProfile?.()
      stopSchedule?.()
      if (!user) {
        clear()
        return
      }
      stopProfile = onSnapshot(doc(db, 'users', user.uid), (profileSnap) => {
        stopSchedule?.()
        const profile = profileSnap.data()
        if (!profile || (profile.role !== 'teacher' && (profile.role !== 'student' || profile.status !== 'approved'))) {
          if (!profileSnap.metadata.fromCache) clear()
          return
        }
        const teacher = profile.role === 'teacher'
        const post = (raw: unknown) => receiver.postMessage({
          owner: user.uid,
          role: teacher ? 'teacher' : 'student',
          school: typeof profile.schoolName === 'string' ? profile.schoolName : '',
          schedule: normalizeWeeklySchedule(raw),
        })
        if (!teacher && typeof profile.classId === 'string' && profile.classId) {
          stopSchedule = onSnapshot(doc(db, 'classes', profile.classId, 'info', 'timetable'), (snapshot) => {
            if (snapshot.exists() || !snapshot.metadata.fromCache) post(snapshot.data())
          }, (error) => console.warn('iOS 시간표 동기화 실패', error.code))
        } else {
          post(teacher ? profile.mySchedule : null)
        }
      }, (error) => console.warn('iOS 프로필 동기화 실패', error.code))
    })
    return () => {
      stopAuth()
      stopProfile?.()
      stopSchedule?.()
    }
  }, [])
  return null
}
