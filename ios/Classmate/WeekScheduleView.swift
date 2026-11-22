import SwiftUI

struct ScheduleSnapshot: Codable, Equatable {
    let owner: String
    let role: String
    let school: String
    let schedule: [String: [String]]

    private static let file = URL.applicationSupportDirectory.appending(path: "classmate-timetable.json")

    static func restore() -> Self? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: file)
    }

    func save() {
        do {
            try FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try JSONEncoder().encode(self).write(to: Self.file, options: [.atomic, .completeFileProtection])
            var file = Self.file
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
        } catch {
            // 시간표는 메모리에서도 확인할 수 있습니다.
        }
    }
}

struct WeekScheduleView: View {
    enum SchoolDay: String, CaseIterable, Identifiable {
        case mon, tue, wed, thu, fri
        var id: Self { self }

        var title: String {
            switch self {
            case .mon: "월"
            case .tue: "화"
            case .wed: "수"
            case .thu: "목"
            case .fri: "금"
            }
        }

        static var today: Self {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "Asia/Seoul") ?? .current
            let day = calendar.component(.weekday, from: Date()) - 2
            return allCases.indices.contains(day) ? allCases[day] : .mon
        }
    }

    let snapshot: ScheduleSnapshot?
    let openPortal: () -> Void
    @State private var day = SchoolDay.today

    var body: some View {
        Group {
            if let snapshot {
                List {
                    if !snapshot.school.isEmpty {
                        Text(snapshot.school).font(.headline)
                            .listRowBackground(Color.clear)
                    }
                    Picker("요일", selection: $day) {
                        ForEach(SchoolDay.allCases) { day in
                            Text(day.title).tag(day)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)

                    Section("\(day.title)요일") {
                        let classes = lessons(snapshot)
                        if classes.isEmpty {
                            Text("등록된 수업이 없어요.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(classes) { lesson in
                            HStack(spacing: 14) {
                                Text("\(lesson.period)교시")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.tint)
                                Text(lesson.title)
                            }
                            .padding(.vertical, 6)
                        }
                    }
                }
                .toolbar {
                    if !lessons(snapshot).isEmpty {
                        ShareLink(item: shareText(snapshot)) {
                            Label("시간표 공유", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("저장된 시간표가 없어요", systemImage: "calendar")
                } description: {
                    Text("클래스메이트에 로그인하면 주간 시간표가 이곳에 저장되어 인터넷이 끊겨도 확인할 수 있어요.")
                } actions: {
                    Button("클래스메이트 열기", action: openPortal)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle(snapshot?.role == "teacher" ? "내 수업 시간표" : "학급 시간표")
    }

    private struct Lesson: Identifiable {
        let period: Int
        let title: String
        var id: Int { period }
    }

    private func lessons(_ snapshot: ScheduleSnapshot) -> [Lesson] {
        (snapshot.schedule[day.rawValue] ?? []).prefix(7).enumerated().compactMap { index, value in
            let title = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? nil : Lesson(period: index + 1, title: title)
        }
    }

    private func shareText(_ snapshot: ScheduleSnapshot) -> String {
        (["\(day.title)요일 시간표"] + lessons(snapshot).map { "\($0.period)교시 \($0.title)" })
            .joined(separator: "\n")
    }
}
