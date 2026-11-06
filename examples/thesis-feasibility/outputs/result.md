# Thesis Feasibility Report: mmWave Radar Person Recognition for Airbnb Check-in (Run 2)

## Executive Summary
With the timeline expanded to **9 months** (3-person team, £1000 budget, owned TI radar), building a reliable entryway sensing testbed, handling multi-modal integration, and conducting thorough empirical trials is **highly feasible**. However, **uniquely identifying new, unregistered guests from gait alone remains an unsolved open-set computer vision problem, and processing biometric data without explicit prior consent retains severe GDPR Article 9 liabilities**.

---

## 1. Requirement & Feasibility Matrix

| Requirement | 9-Month Feasibility | Key Evidence & Impact |
|---|---|---|
| **R1: Technical Feasibility** | **Mixed** (Presence/Closed-Set Proven; Open-Set High Risk) | TI IWR6843 achieves 95%+ accuracy on pre-registered subjects ([ti-iwr6843-gait](../sources/ti-iwr6843-gait.md)), but open-set recognition of novel guests from sparse point clouds remains unsolved ([mmgait-open-set](../sources/mmgait-open-set.md)). |
| **R2: Team & Budget (9 Months, £1000)** | **Fully Feasible** | 9 months provides ample buffer (detailed in [feasibility-critic](work/feasibility-critic.md)) for hardware bring-up, data logging, perturbation tests, and thesis writing. £1000 easily covers edge compute and mounts. |
| **R3: Privacy & Airbnb Rules** | **Compliant for Occupancy; Prohibitive for Biometrics** | mmWave radar complies with Airbnb's strict indoor camera ban ([airbnb-indoor-camera-policy](../sources/airbnb-indoor-camera-policy.md)), but identifying individuals from gait requires explicit opt-in under GDPR Article 9 ([gdpr-article-9-biometrics](../sources/gdpr-article-9-biometrics.md)). |
| **R4: Proven vs. Risky Breakdown** | **Complete** | Proven: presence, headcount, closed-set classification. Risky: open-set gait, luggage/coat interference, biometric consent. |

---

## 2. What the Checkers Caught (Critical Flags)
> ⚠️ **Feasibility critic & Privacy scout**:
> 1. **The Open-Set Barrier**: Extending the timeline from 6 to 9 months gives your team time to study perturbation edge cases (luggage, outerwear), but **does not solve zero-shot biometric identification** on unseen guests without baseline training data.
> 2. **GDPR Article 9**: Unconsented capture of gait biometrics to identify Airbnb guests is legally high-risk regardless of how many months are spent on development.

---

## 3. Recommended Research Directions (9-Month Scope)
1. **Option A: Privacy-Preserving Headcount & Party Detection (Recommended)**
   Reposition the thesis to verify occupancy count and detect unauthorized parties. 100% technically feasible within 9 months, fully permitted under Airbnb sensor policy, and zero GDPR biometric issues.
2. **Option B: Multi-Modal Check-in Verification**
   Pair the radar with a smart lock or mobile digital key. The key identifies the reservation, while the radar verifies physical entry (e.g. single-person entry without tailgating).
3. **Option C: Academic Study on Open-Set Radar Biometric Bounds**
   Frame the thesis around charting the exact failure boundaries of open-set mmWave gait recognition under realistic household variations.

---

*The updated evidence and timeline trade-offs are laid out above; the final direction of your thesis is entirely your decision.*
