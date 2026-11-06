# Thesis Feasibility Report: mmWave Radar Person Recognition for Airbnb Check-in

## Executive Summary
This report evaluates the technical feasibility, engineering constraints, and legal/platform compliance of using Texas Instruments (TI) mmWave radar to recognise guests checking into an Airbnb.

The project is **technically feasible as an occupancy/tracking and closed-set classification prototype** within a 6-month timeline, £1000 budget, and 3-person team using your existing TI radar. However, **uniquely identifying new, unregistered guests from gait alone in an open-set Airbnb scenario is scientifically unproven and introduces critical GDPR compliance risks**.

---

## 1. Requirement Assessments

### R1: Technical Feasibility of mmWave Person Identification
- **Closed-Set Gait Classification (Proven)**: In academic settings with pre-enrolled participants, TI 60–64 GHz radars (e.g. IWR6843) achieve 95%–98% identification accuracy using micro-Doppler spectrograms and CNNs ([ti-iwr6843-gait](../sources/ti-iwr6843-gait.md)).
- **Open-Set Identification of New Guests (High Risk / Unsolved)**: In real-world Airbnb operations, hosts do not have pre-recorded baseline gait data for incoming guests. Open-set gait recognition from sparse point clouds remains an open research challenge with high false acceptance rates ([mmgait-open-set](../sources/mmgait-open-set.md)).
- **Environmental Distortions**: Entryway factors such as bulky luggage, heavy coats, or multiple people entering simultaneously heavily disrupt point cloud clusters and gait signatures.

### R2: Resource Constraints (3-Person Team, 6 Months, £1000 Budget)
- **Team**: The 3-person division (hardware, AI, software) matches the engineering pipeline: hardware brings up TI firmware and UART streaming; AI handles Range-Doppler processing and neural networks; software manages the host dashboard.
- **Budget**: £1000 is fully adequate since you already own the TI radar. Edge compute (Raspberry Pi 5 / Jetson Orin Nano) and mounting rigs require approximately £200–£350.
- **Timeline**: 6 months provides sufficient runway to build a working experimental testbed and evaluate closed-set models, but is insufficient to solve generalized open-set biometric identification.

### R3: Privacy Compliance and Airbnb Platform Policies
- **Airbnb Policy Compliance (Advantageous)**: Airbnb strictly bans all indoor security cameras and video recording devices globally ([airbnb-indoor-camera-policy](../sources/airbnb-indoor-camera-policy.md)). mmWave radar captures zero optical images and zero audio, making it legally distinct from cameras and permissible if disclosed as a non-recording occupancy sensor.
- **GDPR Article 9 Biometric Restrictions (Critical Risk)**: Processing biometric gait data to uniquely identify individuals without prior explicit consent violates GDPR Article 9 ([gdpr-article-9-biometrics](../sources/gdpr-article-9-biometrics.md)).

### R4: Proven vs. Risky Components Matrix

| Component | Status | Key Evidence & Notes |
|---|---|---|
| **Human Presence & Headcount** | **Proven** | Reliable up to 6m using TI standard People Counting demo. |
| **Indoor Camera Ban Bypass** | **Proven** | No visual or audio capture; complies with Airbnb sensor rules if disclosed ([airbnb-indoor-camera-policy](../sources/airbnb-indoor-camera-policy.md)). |
| **Closed-Set Gait Recognition** | **Proven** | 95%+ classification on pre-registered subjects ([ti-iwr6843-gait](../sources/ti-iwr6843-gait.md)). |
| **Open-Set New Guest Recognition** | **High Risk** | No prior training data for new guests; point clouds too sparse for zero-shot identification ([mmgait-open-set](../sources/mmgait-open-set.md)). |
| **Luggage & Multi-Person Entry** | **High Risk** | Severe interference with gait Doppler dynamics. |
| **Biometric Privacy Consent** | **High Risk** | Legal barrier under GDPR Article 9 for non-consensual guest identification ([gdpr-article-9-biometrics](../sources/gdpr-article-9-biometrics.md)). |

---

## 2. Key Flags Raised by Checkers
> **Critical Flag (Feasibility critic)**: Attempting to recognize *unseen* guests entering an Airbnb without pre-enrollment is an unsolved open-set problem in radar literature. Furthermore, capturing biometric gait profiles without explicit guest opt-in violates GDPR Article 9.

---

## 3. Recommended Research Directions

1. **Option A: Pivot to Privacy-Preserving Party & Occupancy Detection**
   Use the TI radar for headcount verification, party detection, and duration tracking in the entryway. This is 100% technically feasible within 6 months, fully aligns with Airbnb sensor policies, and avoids biometric GDPR issues.
2. **Option B: Multi-Modal Check-in Verification**
   Pair the radar with a smart lock or mobile key. The key identifies the booking, while the radar verifies physical entry kinematics (e.g. confirming single-person entry without tailgating).
3. **Option C: Pure Academic Thesis on Open-Set Radar Gait Recognition**
   Treat the open-set problem as the core academic contribution of the thesis, evaluating neural network novelty detection on volunteer cohorts.

---

*The evidence and risk trade-offs are laid out above; the final direction of your thesis is entirely your decision.*
