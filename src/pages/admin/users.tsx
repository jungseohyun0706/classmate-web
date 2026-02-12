import React, {useEffect, useState} from 'react'
import {auth, db} from '../../lib/firebase'
import {onAuthStateChanged} from 'firebase/auth'
import {collection, getDocs, doc, updateDoc} from 'firebase/firestore'
import {useRouter} from 'next/router'

export default function UsersPage(){
  const router = useRouter()
  const [users,setUsers]=useState([])
  useEffect(()=>{
    const unsub = onAuthStateChanged(auth, async user=>{
      if(!user) return router.push('/auth/login')
      const snap = await getDocs(collection(db,'users'))
      setUsers(snap.docs.map(d=>({id:d.id,...d.data()})))
    })
    return ()=>unsub()
  },[])
  async function toggleAdmin(u){
    const ref = doc(db,'users',u.id)
    const newRole = u.role==='admin'?'teacher':'admin'
    await updateDoc(ref,{role:newRole})
    setUsers(users.map(x=> x.id===u.id?{...x,role:newRole}:x))
  }
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">User Management</h1>
      <table className="min-w-full mt-4">
        <thead><tr><th>Email</th><th>Role</th><th>SchoolId</th><th>Actions</th></tr></thead>
        <tbody>
          {users.map((u:any)=> (
            <tr key={u.id} className="border-t">
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.schoolId||'-'}</td>
              <td><button onClick={()=>toggleAdmin(u)} className="text-sm px-2 py-1 bg-gray-200 rounded">Toggle Role</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
