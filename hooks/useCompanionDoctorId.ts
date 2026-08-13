"use client";

import { useEffect, useState } from "react";
import {
  getCachedCompanionDoctorId,
  loadCompanionDoctorId,
} from "@/lib/auth/doctorId";

export function useCompanionDoctorId() {
  const [doctorId, setDoctorId] = useState(() => getCachedCompanionDoctorId());

  useEffect(() => {
    let cancelled = false;
    void loadCompanionDoctorId().then((id) => {
      if (!cancelled && id) {
        setDoctorId(id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return doctorId;
}
