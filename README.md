# EarnJoy — Backend MVP

## สิ่งที่มี
- สมัครสมาชิก / Login (JWT + bcrypt)
- ภารกิจ
- Claim ภารกิจ
- ยอดพร้อมรับ / ยอดรอตรวจ / ยอดสะสม
- ขอถอนเงิน
- Admin ตรวจและอนุมัติ/ปฏิเสธภารกิจ
- Admin ตรวจและอนุมัติ/ปฏิเสธคำขอถอน
- JSON database สำหรับการทดลอง

## วิธีรัน
1. ติดตั้ง Node.js 20+ (แนะนำ LTS)
2. เปิด Terminal ในโฟลเดอร์นี้
3. `npm install`
4. `npm start`
5. เปิด `http://localhost:3000`

## สร้าง Admin ครั้งแรก
ส่ง POST ไปที่ `/api/admin/setup` เช่น:

```json
{"name":"EarnJoy Admin","email":"admin@example.com","password":"เปลี่ยนเป็นรหัสผ่านจริง"}
```

ใช้ Postman/Insomnia หรือ curl จากเครื่องของคุณ

## สำคัญก่อนเปิดเงินจริง
นี่เป็น MVP สำหรับพัฒนาและทดสอบ ไม่ใช่ระบบ production:
- เปลี่ยน JWT_SECRET
- ใช้ฐานข้อมูลจริง เช่น PostgreSQL/MySQL
- ใช้ HTTPS
- เพิ่ม rate limiting, audit log, CSRF/CORS policy ตามสถาปัตยกรรมจริง
- เพิ่ม KYC/การยืนยันข้อมูลเท่าที่กฎหมายและผู้ให้บริการจ่ายเงินกำหนด
- เชื่อม Affiliate network ที่อนุญาตรูปแบบ incentive ที่ใช้จริง
- เชื่อมผู้ให้บริการจ่ายเงินที่มีสิทธิให้บริการ
- ตรวจสอบกฎหมาย/ภาษี/PDPA ก่อนเปิดให้บริการจริง
- อย่าใส่เงินหรือข้อมูลรับเงินจริงใน environment ทดสอบ
