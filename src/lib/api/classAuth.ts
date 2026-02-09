import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";

/**
 * 반 ID 생성 유틸
 */
export function generateClassId(schoolCode: string, grade: string, classNm: string) {
  return `${schoolCode}_${grade}_${classNm}`;
}

/**
 * 해당 반이 이미 생성되어(비밀번호가 설정되어) 있는지 확인
 */
export async function checkClassExists(classId: string): Promise<boolean> {
  try {
    const ref = doc(db, "classes", classId);
    const snap = await getDoc(ref);
    return snap.exists();
  } catch (e) {
    console.error("Error checking class:", e);
    return false;
  }
}

/**
 * 반 최초 생성 (비밀번호 설정)
 */
export async function createClass(classId: string, password: string, schoolName: string) {
  try {
    await setDoc(doc(db, "classes", classId), {
      password, // 보안상 해시가 좋지만 MVP니까 평문 저장 (추후 개선 필요)
      schoolName,
      createdAt: Date.now(),
    });
    return true;
  } catch (e) {
    console.error("Error creating class:", e);
    return false;
  }
}

/**
 * 비밀번호 검증
 */
export async function verifyClassPassword(classId: string, password: string): Promise<boolean> {
  try {
    const ref = doc(db, "classes", classId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return false;

    const data = snap.data();
    return data.password === password;
  } catch (e) {
    console.error("Error verifying password:", e);
    return false;
  }
}
