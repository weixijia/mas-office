# Engineering Feasibility & Risk Critique (9-Month Timeline)

## 1. Resource & Constraint Evaluation
- **Team Composition (3 Persons)**:
  - Hardware engineer: Interface TI mmWave radar (DCA1000EVM data capture or IWR UART/SPI streaming) with host MCU/SBC.
  - AI engineer: Signal pre-processing (FFT, CFAR, micro-Doppler extraction) and neural network inference.
  - Software engineer: Local database/dashboard, notification alerts, and Airbnb host integration.
  - *Verdict*: Skill allocation is well-balanced for an academic prototype.
- **Budget (£1000)**:
  - Radar: £0 (TI radar already owned).
  - Compute & Mounting: Raspberry Pi 5 / Jetson Orin Nano (~£100–£250), power supply, 3D enclosure (~£50).
  - Testbed & Travel/Staging: ~£200 for simulated entryway setup and volunteer participant stipends.
  - *Verdict*: Budget is fully sufficient for an academic proof-of-concept.
- **Timeline (9 Months — Expanded from 6 Months)**:
  - Months 1–2: Hardware testbed bring-up, TI SDK firmware configuration, raw data logging pipeline (UART/SPI streaming).
  - Months 3–4: Feature extraction (Range-Doppler, point cloud clustering), model training on closed-set volunteer cohort.
  - Months 5–6: Extensive perturbation studies (varying angles, walking speeds, outerwear, and luggage effects).
  - Months 7–8: Investigation of metric learning / few-shot novelty detection to test the limits of open-set classification; hallway staging.
  - Month 9: Final evaluation, ablation studies, and comprehensive thesis write-up.
  - *Verdict*: The 9-month duration significantly relieves engineering pressure and provides ample time for rigorous experimental evaluation, but it fundamentally cannot overcome the theoretical and privacy barriers of open-set biometric recognition without guest pre-enrollment.

## 2. Proven vs. Risky Components Breakdown

| Component | Status | Evidence / Analysis |
|---|---|---|
| **Human Presence & Tracking** | **Proven** (Low Risk) | TI out-of-the-box People Counting demo operates reliably up to 6m; documented extensively in TI Industrial SDKs. |
| **Indoor Camera Ban Bypass** | **Proven** (Low Risk) | As established in [airbnb-indoor-camera-policy](../../sources/airbnb-indoor-camera-policy.md), radar transmits no optical video, fitting within permissible sensor policies if disclosed. |
| **Closed-Set Gait Recognition** | **Proven** (Medium Risk) | Academic literature ([ti-iwr6843-gait](../../sources/ti-iwr6843-gait.md)) demonstrates 95%+ accuracy for pre-enrolled subjects walking along standard paths. |
| **Open-Set New Guest Identification** | **High Risk / Unsolved** | An Airbnb check-in is inherently open-set. As shown in [mmgait-open-set](../../sources/mmgait-open-set.md), identifying an unregistered guest without prior baseline gait data is scientifically unproven. Even with 9 months, open-set zero-shot identification remains an open research problem. |
| **Multi-Person & Luggage Entry** | **High Risk** | Real Airbnb guests arrive with rolling bags, heavy coats, or in groups, disrupting gait kinetics and scattering radar reflections. 9 months allows studying these perturbations, but reliable biometric separation remains difficult. |
| **Biometric Legal Compliance** | **High Risk** | Under [gdpr-article-9-biometrics](../../sources/gdpr-article-9-biometrics.md), capturing biometric gait data to identify guests without prior explicit consent breaches data protection laws, regardless of project duration. |

## 3. Recommended Pivot for the Thesis
With 9 months, the team has the luxury of executing either:
1. **Privacy-Preserving Occupancy & Unauthorized Guest / Party Detection**: Reliably counting headcounts and detecting unregistered group gatherings without violating Airbnb indoor camera policies. (Completely feasible within 9 months).
2. **Multi-Modal Hybrid Check-in**: Combining radar presence verification with a mobile app or smart lock token (e.g. radar confirms that exactly one person walked through when the digital key was activated).
3. **Rigorous Academic Negative Result / Boundary Analysis**: Using the 9 months to document the precise physical and informational boundaries of open-set mmWave gait recognition, demonstrating where and why radar biometrics fail in unconstrained hospitality environments.

## 3-Line Summary
1. The expanded 9-month timeline and £1000 budget comfortably accommodate full hardware bring-up, extensive empirical trials, and thesis writing.
2. The extra 3 months enable thorough perturbation and metric learning tests, but open-set recognition of unseen guests remains scientifically unproven.
3. Repositioning the thesis toward non-biometric occupancy/party detection or multi-modal verification guarantees a successful, legally compliant outcome.
