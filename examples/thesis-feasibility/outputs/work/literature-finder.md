# Literature Review: TI mmWave Radar Person & Gait Recognition

## 1. Hardware & Sensing Pipeline
- **Radar Hardware**: Texas Instruments 60 GHz–64 GHz FMCW sensors (notably TI IWR6843 / IWR6843ISK-ODS and IWR1443).
- **Data Modalities**:
  - **Micro-Doppler Spectrograms**: High-resolution Doppler velocity shifts induced by torso and limb swinging.
  - **3D Sparse Point Clouds**: Spatial coordinates ($X, Y, Z$), Doppler velocity, and signal reflection intensity (SNR).
  - **Edge Processing**: TI on-chip hardware accelerators (HWA) and C674x DSP can generate Range-Doppler maps and point clouds directly on-device.

## 2. Key Academic Benchmarks & Accuracy
- **Closed-Set Gait Recognition**:
  - In studies like [ti-iwr6843-gait](../../sources/ti-iwr6843-gait.md), multi-layer CNNs trained on micro-Doppler and skeletal tracking achieve 95%–98% classification accuracy when distinguishing among a fixed, pre-enrolled cohort (e.g., 10–20 known subjects).
  - Fixed-path walking yields the highest accuracy; free-walking paths degrade accuracy by 8%–15%.
- **Open-Set Identification Limitations**:
  - Recent benchmarks such as [mmgait-open-set](../../sources/mmgait-open-set.md) demonstrate that open-set recognition (evaluating unseen or novel individuals) suffers from high false-acceptance rates and latent feature drift due to point cloud sparsity.

## 3. Sensing Range & Failure Modes
- **Effective Range**: Typically 1.0 m to 6.0 m for micro-Doppler gait extraction; beyond 6 m, point density degrades rapidly.
- **Occlusions & Multi-Person Coexistence**: Two people entering together severely scramble point clusters and micro-Doppler signatures.
- **Carrying Objects & Outerwear**: Bulky coats, luggage, or hands in pockets significantly distort arm-swing kinematics, causing signature mismatches.

## 3-Line Summary
1. TI mmWave radars (IWR6843) achieve 95%+ accuracy for closed-set gait identification when users are pre-enrolled.
2. Sparse radar point clouds make open-set identification of brand-new, unseen individuals an unsolved academic challenge.
3. Multi-person entry and carrying luggage are major real-world failure modes for entryway identification.
