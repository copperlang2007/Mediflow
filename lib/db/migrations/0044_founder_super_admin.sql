-- One-time founder bootstrap. Grant the existing active owner account only
-- when the email identifies exactly one row; ambiguity leaves roles untouched.
UPDATE users
SET role = 'super_admin', updated_at = now()
WHERE id = (
  SELECT min(id)
  FROM users
  WHERE lower(email) = 'lang@theartificialbridge.com'
    AND is_active = true
  HAVING count(*) = 1
);