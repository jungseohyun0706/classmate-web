import { require } from './env.mjs'
const fs = require('firebase/firestore')
export const { doc, updateDoc, setDoc, getDoc, getDocs, collection, query, where, addDoc, deleteDoc, serverTimestamp, runTransaction } = fs
