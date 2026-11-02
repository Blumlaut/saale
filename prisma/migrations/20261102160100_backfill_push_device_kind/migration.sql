-- The rows subscribed before `deviceKind` existed read as computers. The user
-- agent they carry is the same guess the subscribe route makes today, so a
-- phone that was already subscribed keeps its place in the second wave.

UPDATE "PushSubscription"
SET "deviceKind" = 'mobile'
WHERE "deviceKind" = 'desktop'
  AND "userAgent" ~* '(Mobi|Android|iPhone|iPad|iPod|IEMobile|Opera Mini)';
