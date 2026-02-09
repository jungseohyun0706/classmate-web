"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Notice = {
  id: string;
  title: string;
  body: string;
  createdAt: any;
};

export default function AdminDashboard() {
  const router = useRouter();
  const [session, setSession] = useState<any>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);

  // 작성 폼
  const [isWriting, setIsWriting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // 세션 체크
    const raw = localStorage.getItem("classmate_admin_session");
    if (!raw) {
      router.replace("/admin");
      return;
    }
    const sess = JSON.parse(raw);
    setSession(sess);

    // 공지 구독
    const ref = collection(db, "classes", sess.classId, "announcements");
    const q = query(ref, orderBy("createdAt", "desc"));

    const unsub = onSnapshot(q, (snap) => {
      const list: Notice[] = [];
      snap.forEach((d) => {
        list.push({ id: d.id, ...d.data() } as Notice);
      });
      setNotices(list);
      setLoading(false);
    });

    return () => unsub();
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem("classmate_admin_session");
    router.replace("/admin");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;

    setSubmitting(true);
    try {
      await addDoc(collection(db, "classes", session.classId, "announcements"), {
        title,
        body,
        createdAt: Timestamp.now(),
        author: "teacher", // 나중에 확장성 고려
      });
      setIsWriting(false);
      setTitle("");
      setBody("");
    } catch (err) {
      alert("작성 실패: " + err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    try {
      await deleteDoc(doc(db, "classes", session.classId, "announcements", id));
    } catch (err) {
      alert("삭제 실패");
    }
  };

  if (!session) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Classmate 관리자</h1>
            <p className="text-sm text-gray-500">
              {session.schoolName} {session.grade}학년 {session.classNm}반
            </p>
          </div>
          <button onClick={handleLogout} className="text-red-500 hover:text-red-700 text-sm font-semibold">
            로그아웃
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-bold text-gray-800">📢 공지사항 관리</h2>
          <button
            onClick={() => setIsWriting(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700 transition"
          >
            + 새 공지 작성
          </button>
        </div>

        {/* 작성 폼 (모달 대신 인라인 확장) */}
        {isWriting && (
          <div className="bg-white rounded-xl shadow p-6 mb-8 border border-blue-100">
            <h3 className="text-lg font-bold mb-4 text-gray-800">새 공지 쓰기</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="text"
                placeholder="제목"
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-black"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <textarea
                placeholder="내용을 입력하세요..."
                className="w-full border border-gray-300 rounded-lg px-4 py-2 h-32 resize-none focus:ring-2 focus:ring-blue-500 outline-none text-black"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsWriting(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {submitting ? "등록 중..." : "등록하기"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* 목록 */}
        {loading ? (
          <p className="text-center text-gray-500 py-10">로딩 중...</p>
        ) : notices.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-dashed border-gray-300">
            <p className="text-gray-400">등록된 공지가 없습니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {notices.map((n) => (
              <div key={n.id} className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-lg font-bold text-gray-900">{n.title}</h3>
                  <button 
                    onClick={() => handleDelete(n.id)}
                    className="text-gray-400 hover:text-red-500 transition"
                  >
                    삭제
                  </button>
                </div>
                <p className="text-gray-600 whitespace-pre-wrap leading-relaxed">{n.body}</p>
                <div className="mt-4 text-xs text-gray-400 text-right">
                  {n.createdAt?.toDate ? n.createdAt.toDate().toLocaleString() : "방금 전"}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
