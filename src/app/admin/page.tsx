"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { searchSchools, type NeisSchool } from "@/lib/api/neisSchoolSearch";
import { verifyClassPassword, generateClassId } from "@/lib/api/classAuth";

export default function AdminLoginPage() {
  const router = useRouter();

  // Step 1: School Search
  const [query, setQuery] = useState("");
  const [schools, setSchools] = useState<NeisSchool[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState<NeisSchool | null>(null);

  // Step 2: Auth
  const [grade, setGrade] = useState("3");
  const [classNm, setClassNm] = useState("1");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async () => {
    if (query.length < 2) return;
    setSearching(true);
    try {
      const result = await searchSchools(query);
      setSchools(result);
    } catch {
      alert("학교 검색 중 오류가 발생했습니다.");
    } finally {
      setSearching(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchool) return;

    setLoading(true);
    setError("");

    try {
      const classId = generateClassId(selectedSchool.SD_SCHUL_CODE, grade, classNm);
      const isValid = await verifyClassPassword(classId, password);

      if (isValid) {
        // 간단한 세션 처리 (localStorage)
        // 실제 운영 시엔 보안 강화 필요 (HttpOnly Cookie 등)
        const sessionData = {
          schoolName: selectedSchool.SCHUL_NM,
          schoolCode: selectedSchool.SD_SCHUL_CODE,
          grade,
          classNm,
          classId,
          isTeacher: true,
          loginAt: Date.now()
        };
        localStorage.setItem("classmate_admin_session", JSON.stringify(sessionData));
        
        router.push("/admin/dashboard");
      } else {
        setError("비밀번호가 일치하지 않거나, 아직 생성되지 않은 반입니다.");
      }
    } catch (err) {
      console.error(err);
      setError("로그인 처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  // --- Render ---

  if (!selectedSchool) {
    // Step 1: 학교 선택
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">선생님 로그인</h1>
          <p className="text-gray-500 mb-6">먼저 학교를 검색해주세요.</p>

          <div className="flex gap-2 mb-4">
            <input
              type="text"
              className="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-black"
              placeholder="학교 이름 (예: 서울고)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700 transition disabled:opacity-50"
            >
              {searching ? "..." : "검색"}
            </button>
          </div>

          <div className="max-h-60 overflow-y-auto space-y-2">
            {schools.map((s) => (
              <button
                key={s.SD_SCHUL_CODE}
                onClick={() => setSelectedSchool(s)}
                className="w-full text-left p-3 rounded-lg hover:bg-gray-100 transition border border-transparent hover:border-gray-200"
              >
                <div className="font-bold text-gray-800">{s.SCHUL_NM}</div>
                <div className="text-sm text-gray-500">{s.ORG_RDNMA}</div>
              </button>
            ))}
            {schools.length === 0 && query.length > 1 && !searching && (
              <p className="text-center text-gray-400 py-4">검색 결과가 없습니다.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Step 2: 정보 입력
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">로그인</h1>
            <p className="text-blue-600 font-semibold">{selectedSchool.SCHUL_NM}</p>
          </div>
          <button 
            onClick={() => { setSelectedSchool(null); setSchools([]); setQuery(""); }}
            className="text-sm text-gray-400 hover:text-gray-600 underline"
          >
            학교 변경
          </button>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">학년</label>
              <select 
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-black bg-white focus:ring-2 focus:ring-blue-500 outline-none"
              >
                {[1, 2, 3, 4, 5, 6].map(g => <option key={g} value={g}>{g}학년</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">반</label>
              <input
                type="number"
                min="1"
                max="20"
                value={classNm}
                onChange={(e) => setClassNm(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-black focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">비밀번호</label>
            <input
              type="password"
              placeholder="앱에서 설정한 관리자 비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2 text-black focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          {error && <p className="text-red-500 text-sm font-medium">{error}</p>}

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-lg hover:bg-blue-700 transition shadow-lg disabled:opacity-50 disabled:shadow-none"
          >
            {loading ? "확인 중..." : "관리자 접속"}
          </button>
        </form>
      </div>
    </div>
  );
}
