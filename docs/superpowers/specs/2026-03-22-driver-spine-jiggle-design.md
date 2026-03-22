# Driver Spine Jiggle — Design Spec

**Date:** 2026-03-22
**Status:** Reviewed

---

## Goal

Add an exaggerated, suspension-driven vertical body translation to the M151A2 driver character so they visually bounce up and down when driving over rough terrain, rather than sitting completely static.

---

## Scope

- File modified: `Testanims2M151A2.agf` (Main sheet)
- No changes to `.agr`, `.ast`, `.asi`, or prefab files
- Driver-seat only (`SeatPositionType == 0` driver state machine path)
- No new variables required — uses existing `suspension_0..3` variables already declared in the AGR

---

## Architecture

### Injection point

The driver animation chain in the `Main` sheet currently flows:

```
Blend T 20303
  └─ Vehicle_Wobble_VarUpdate
       └─ Driver_UnconsciousQ
            └─ VehicleIK 28738
                 └─ Blend 42669
                      └─ ...
```

A single new `ProcTransform` node (`DriverSpineJiggle`) is inserted between `Vehicle_Wobble_VarUpdate` and `Driver_UnconsciousQ`:

```
Blend T 20303
  └─ Vehicle_Wobble_VarUpdate
       └─ DriverSpineJiggle  ← NEW
            └─ Driver_UnconsciousQ
                 └─ VehicleIK 28738
                      └─ Blend 42669
                           └─ ...
```

### Changes required

1. **Edit** `Vehicle_Wobble_VarUpdate.Child` from `"Driver_UnconsciousQ"` to `"DriverSpineJiggle"`
2. **Add** new `AnimSrcNodeProcTransform DriverSpineJiggle` node to the Main sheet `Nodes {}` block

### New node definition

```
AnimSrcNodeProcTransform DriverSpineJiggle {
 EditorPos -25.3 5.9
 NodeGroup "Jiggles"
 Child "Driver_UnconsciousQ"
 Expression "(abs(suspension_0) + abs(suspension_1) + abs(suspension_2) + abs(suspension_3)) * sin(GetUpperRTime() * 15) * 0.14"
 Bones {
  AnimSrcNodeProcTrBoneItem "{A1B2C3D4E5F60001}" {
   Bone "spine_01"
   Axis Y
   Op Translate
  }
 }
}
```

**GUID note:** The `{A1B2C3D4E5F60001}` placeholder will be replaced by Workbench with a real GUID on first open/save. Any unique-looking hex string works as the placeholder — just ensure it doesn't literally match another GUID already in the file.

**Node-level `Expression` behaviour:** In `ProcTransform`, the `Expression` field is the per-frame amount applied to all bones that have no `Amount` property. This matches the confirmed pattern from the working `Wipers` node (`Expression "sin(GetUpperRTime() * -pi) * 1.5"`, no `Amount` on bones). No separate `Amount` or `Space` field is required on the bone item.

---

## Expression breakdown

```
(abs(suspension_0) + abs(suspension_1) + abs(suspension_2) + abs(suspension_3)) * sin(GetUpperRTime() * 15) * 0.14
```

| Part | Role |
|---|---|
| `abs(suspension_N)` per wheel | Per-wheel absolute compression. Avoids the cancellation problem where left-compress + right-extend would sum to zero even during active suspension travel. Each wheel contributes independently. |
| `abs(s0) + abs(s1) + abs(s2) + abs(s3)` | Total suspension activity across all wheels (0–4 range) |
| `abs(...)` — design note | Using `abs()` per-wheel rather than `abs(sum)` means diagonally opposite corners compressing/extending simultaneously still produce full amplitude, not zero. |
| `sin(GetUpperRTime() * 15)` | Oscillation at ~2.4 Hz — fast enough to feel like vibration |
| `* 0.14` | Scale factor. At 4-wheel full compression: peak travel = `4 × 0.14 = 0.56` units |

**Behaviour:**
- Flat road, all suspensions near 0 → barely moves
- Moderate rough terrain, average suspension ~0.3 per wheel → peak ~0.17 units travel
- Heavy off-road / big bump, average suspension ~0.7 → peak ~0.39 units travel

---

## Open question

Bone name `spine_01` must be verified against the M151A2 character rig. If wrong, the ProcTransform is silently ignored (no crash, no visible effect).

**How to verify:** Check the `IkChains {}` block in the `.agr` — the joint names there reveal the rig naming convention. Alternatively, open the Animation Editor with the character, inspect the bone list. Alternative candidates to try: `spine_02`, `Spine1`, `pelvis`.

**Resolution path:** If `spine_01` produces no visible effect, try `spine_02`, then `pelvis`. The correct name will immediately be obvious in-game.

**Chain note:** Only `Vehicle_Wobble_VarUpdate.Child` changes. `Driver_UnconsciousQ.Child` (which is `VehicleIK 28738`) remains untouched — the rest of the chain is unaffected by this insertion.

---

## What is NOT changing

- Co-driver, passenger, and passenger-rear seat paths are unaffected
- No IK chain modifications
- No AGR variable additions
- Body sheet (wipers, dashboard, existing Jiggles node) unchanged
- Vehicle chassis animation unchanged

---

## Tuning

To adjust intensity after testing, change the `0.14` multiplier in the expression:
- `0.05` = subtle
- `0.14` = exaggerated (current design target)
- `0.25`+ = extreme

To adjust frequency, change `15` (rad/s):
- `8` = slow heavy bounce
- `15` = fast road vibration (current)
- `20` = very rapid shimmy
