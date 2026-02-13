"use client";

import React, { useState } from "react";
import { ref, uploadBytesResumable, getDownloadURL, getStorage } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { getFunctions } from "firebase/functions";
import { initFirebase } from "@/lib/firebase";
const storage = getStorage(initFirebase());

export default function AdminComposePage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [classId, setClassId] = useState("");
  const [password, setPassword] = useState("");

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !body || !classId || !password) return setMessage("제목/본문/반/비밀번호를 입력하세요.");
    setSending(true);
    setMessage("");

    try {
      const attachments: any[] = [];

      if (file) {
        const storageRef = ref(storage, `notices/${Date.now()}_${file.name}`);
        const snap = await uploadBytesResumable(storageRef, file);
        const url = await getDownloadURL(snap.ref);
        attachments.push({ name: file.name, url });
      }

      const functions = getFunctions();
      const fn = httpsCallable(functions, "createAnnouncementSecure");
      // placeholder
      const res: any = await fn({ classId, password, title, body, attachments });

      if (res.data?.ok) {
        setMessage("공지 발송 성공 — 학생들에게 푸시가 전송됩니다.");
        setTitle("");
        setBody("");
        setFile(null);
      } else {
        setMessage("전송 중 문제가 발생했습니다.");
      }
    } catch (err: any) {
      console.error(err);
      setMessage(err?.message || "오류가 발생했습니다.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="text-2xl font-bold mb-4">공지 작성 (관리자)</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold mb-1">반 ID (예: 123456_3_1)</label>
          <input value={classId} onChange={(e) => setClassId(e.target.value)} className="w-full border rounded px-3 py-2 text-black" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">관리자 비밀번호</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full border rounded px-3 py-2 text-black" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">제목</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border rounded px-3 py-2 text-black" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">본문</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="w-full border rounded px-3 py-2 text-black" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1">첨부파일 (선택, 최대 10MB)</label>
          <input type="file" onChange={handleFile} />
          {file && <div className="text-sm mt-1">선택됨: {file.name}</div>}
        </div>
        <div>
          <button type="submit" disabled={sending} className="bg-blue-600 text-white px-4 py-2 rounded">
            {sending ? "전송 중..." : "공지 발송"}
          </button>
        </div>
        {message && <div className="mt-2 text-sm">{message}</div>}
      </form>
    </div>
  );
}
