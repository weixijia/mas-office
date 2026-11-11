import MASOfficeKit
import SwiftUI

/// The claim popover: the verdict in words, who checked it and how, and the cited sources with their evidence
/// grade (a different thing from the verdict) and link health.
struct ClaimDetailView: View {
    var detail: ClaimDetail
    var nameOf: (String) -> String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                B_VerdictChip(status: detail.status)
                if let a = detail.author {
                    Text("claimed by \(nameOf(a))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            Text(B_ClaimStyle.meaning(detail.status)).font(.callout).foregroundStyle(.secondary)
            if !detail.text.isEmpty {
                Text(detail.text)
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Verdicts").font(.subheadline.weight(.semibold))
                if detail.verdicts.isEmpty {
                    Text("No checker has looked at this claim yet.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(Array(detail.verdicts.enumerated()), id: \.offset) { _, v in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(nameOf(v.by ?? "")).font(.callout.weight(.medium))
                            B_VerdictChip(status: v.status, compact: true)
                            if let b = v.backend {
                                Text(BackendStatus.label(b)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        if let note = v.note {
                            Text(note).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Cited sources").font(.subheadline.weight(.semibold))
                if detail.sources.isEmpty {
                    Text("No source cited.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(detail.sources) { s in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        B_GradeBadge(grade: s.grade)
                        VStack(alignment: .leading, spacing: 2) {
                            if let url = s.url {
                                Link(s.title, destination: url).font(.callout).help(url.absoluteString)
                            } else {
                                Text(s.title).font(.callout)
                            }
                            HStack(spacing: 8) {
                                if let g = s.grade { Text(g.meaning).font(.caption).foregroundStyle(.secondary) }
                                B_HealthLabel(health: s.health, httpStatus: s.httpStatus)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .padding(14)
        .frame(width: 340, alignment: .leading)
    }
}

/// The popover content for a claim id, from the store (nil when the verification does not list it).
struct ClaimPopoverContent: View {
    @Environment(OfficeStore.self) private var store
    var claimId: String

    var body: some View {
        if let d = ClaimDetail(claimId: claimId, verification: store.snapshot.verification, result: store.snapshot.result) {
            ClaimDetailView(detail: d, nameOf: store.displayName)
        } else {
            Text("This claim has not been checked.").padding(14)
        }
    }
}
