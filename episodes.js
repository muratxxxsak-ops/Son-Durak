// Hazır taslaklar – yönetim panelinde "Taslağı yükle" ile forma doldurulur.
export const INTRO =
  "42 SD 317 plakalı otobüs, her gece Konya'dan kalkan son seferdir. Ama bu gece yolu bambaşka bir yere çıkacak. " +
  "Önünde 41 durak var. Her durakta otobüse yeni yolcular binecek, bazıları ise bir daha görünmeyecek. " +
  "Sen de bu otobüstesin. Koltuğun seni bekliyor. Her gün bir durak, her gün bir seçim. " +
  "Rıza'nın ne yapacağına sen karar vereceksin. Son Durak'a kim varacak, orada ne bekliyor? Bunu kimse bilmiyor... henüz.";

export const DRAFTS = {
  "1": {
    number: 1,
    stop: "1. DURAK",
    title: "03:17",
    intro: INTRO,
    body: [
      "Şoför Rıza, Konya'dan kalkan son seferin dönüş yolundadır. Otobüs boştur, radyoda sadece cızırtı vardır. Saat 03:17'yi gösterdiğinde farlar bir anlığına söner.",
      "Farlar geri yandığında yol değişmiştir. Asfalt bitmiş, toprak bir yol başlamıştır. Navigasyon \"Konum bulunamadı\" yazar. Uzakta tek bir sokak lambası yanar.",
      "Lambanın altında eski, paslı bir durak tabelası vardır: \"1. DURAK\". Tabelanın altında silik harflerle bir ok ve şu yazı: \"Son Durak'a 41 durak\". Durakta yolcular bekler. Kimse konuşmaz, kimse el kaldırmaz. Hepsi aynı anda başını kaldırıp otobüse bakar.",
      "Rıza saate bakar: 03:17. Saniye ilerlemiyor. Dikiz aynasında, boş olması gereken arka koltukta, bir an için bir siluet görür. Tekrar baktığında kimse yoktur.",
      "Duraktaki yolculardan biri yavaşça kapıya yaklaşır ve cama vurur. Bir kez. İki kez."
    ].join("\n\n"),
    choices: [
      { key: "A", text: "Rıza kapıyı açar ve yolcuları alır." },
      { key: "B", text: "Rıza kapıyı açmadan gaza basar." },
      { key: "C", text: "Rıza kapıyı açmaz, camı aralayıp yolcuya \"Nereye gidiyorsunuz?\" diye sorar." }
    ]
  },
  "2A": {
    number: 2, stop: "2. DURAK", title: "Kapı açıldı", intro: "",
    body: [
      "Kapı tıslayarak açılır. Yolcular tek tek biner, her biri boş bir koltuğa oturur. Hiçbiri bilet uzatmaz.",
      "Son binen yaşlı bir kadındır. Rıza'nın yanından geçerken fısıldar: \"Geç kaldın evladım. Biz seni yıllardır bekliyoruz.\"",
      "Otobüs kalkar. Saat hâlâ 03:17. Dikiz aynasında Rıza bir şey fark eder: aynada yolcuların hiçbirinin yansıması yoktur. Sadece bir tanesinin vardır. 7 numaralı koltuktaki yolcunun."
    ].join("\n\n"),
    choices: [
      { key: "A", text: "Rıza 7 numaralı yolcuyla konuşur." },
      { key: "B", text: "Rıza bir şey fark etmemiş gibi sürmeye devam eder." }
    ]
  },
  "2B": {
    number: 2, stop: "2. DURAK", title: "Gaza basıldı", intro: "",
    body: [
      "Rıza gaza basar. Durak geride kalır, yolcular kıpırdamadan otobüsün arkasından bakar. Rıza rahat bir nefes alır.",
      "Beş dakika sonra yine bir sokak lambası belirir. Yine paslı bir tabela vardır: \"1. DURAK\". Aynı yolcular, aynı yerde bekler. Ama bu sefer ellerinde bavul yoktur, hepsi Rıza'ya el sallar.",
      "Telsiz cızırdar ve bir ses yalnızca tek kelime söyler: \"Kaçamazsın.\""
    ].join("\n\n"),
    choices: [
      { key: "A", text: "Bu sefer kapıyı açar." },
      { key: "B", text: "Otobüsü geri çevirip geldiği yoldan dönmeye çalışır." }
    ]
  },
  "2C": {
    number: 2, stop: "2. DURAK", title: "Cam aralandı", intro: "",
    body: [
      "Rıza camı biraz aralar. Dışarıdan soğuk ve nemli bir hava girer. \"Nereye gidiyorsunuz?\" diye sorar.",
      "Cama vuran genç adam bir süre sessiz kalır. Sonra cebinden buruşuk bir otobüs bileti çıkarıp camdan içeri uzatır. Biletin üstünde tarih yazar: 14 Kasım 1987. Varış yeri: \"Son Durak\". Yolcu adı: Rıza.",
      "Adam gülümser: \"Senin gittiğin yere.\""
    ].join("\n\n"),
    choices: [
      { key: "A", text: "Bileti alır ve kapıyı açar." },
      { key: "B", text: "Bileti yırtıp camı kapatır." }
    ]
  }
};
