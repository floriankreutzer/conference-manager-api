// Pure versioned business facts. No credential, role, runtime or provider authority.
const BUSINESS_TEMPLATES = [
  {
    "id": "10000000-0000-4000-8000-000000000001",
    "displayName": "Northwind Demo",
    "lifecycleStatus": "active",
    "lifecycleRevision": 1,
    "settings": {
      "organization": {
        "name": "Northwind Demo GmbH",
        "countryCode": "DE"
      },
      "locations": [
        {
          "id": "11000000-0000-4000-8000-000000000001",
          "name": "Berlin Demo Campus",
          "timeZone": "Europe/Berlin",
          "guestInformation": {
            "address": {
              "line1": "Example Campus 1",
              "line2": null,
              "postalCode": "10115",
              "city": "Berlin",
              "countryCode": "DE"
            },
            "publicTransport": "Use the public transport stop at the campus entrance.",
            "arrival": "Please arrive ten minutes before the meeting.",
            "parking": "Visitor parking is signposted at the main entrance.",
            "reception": "Register at the main reception.",
            "building": "Conference building",
            "visitorNotes": "Synthetic demonstration information.",
            "accessibility": "Step-free entrance and lift.",
            "wifiPolicy": "credentials_on_arrival",
            "wifiNetworkName": "Demo Guest",
            "contact": {
              "name": "Demo Reception",
              "email": "reception@example.invalid",
              "phone": null
            },
            "routeUrl": null
          },
          "rooms": [
            {
              "id": "northwind-berlin-room-1",
              "description": "Großzügiger Konferenzraum mit Tageslicht, variabler Bestuhlu" +
                "ng und Videokonferenztechnik. Geeignet für Kundenpräsentatio" +
                "nen, Projekt-Kick-offs und bereichsübergreifende Workshops.",
              "name": "Berlin Forum",
              "capacity": 24,
              "priceMinor": 12500,
              "floor": "EG",
              "equipment": [
                "display-86",
                "video-system",
                "whiteboard",
                "wireless-mic"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-2",
              "description": "Ruhiger Besprechungsraum mit zentralem Konferenztisch, ergon" +
                "omischen Stühlen und schallgedämpften Oberflächen. Für vertr" +
                "auliche Abstimmungen und hybride Entscheidungstermine.",
              "name": "Spree Boardroom",
              "capacity": 12,
              "priceMinor": 9500,
              "floor": "1. OG",
              "equipment": [
                "display-65",
                "video-system",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-3",
              "description": "Flexibel nutzbarer Workshopraum mit mobilen Tischen, großen " +
                "Schreibflächen und Platz für Gruppenarbeit. Moderationsmater" +
                "ial und mobile Pinnwände sind direkt verfügbar.",
              "name": "Workshop Loft",
              "capacity": 20,
              "priceMinor": 11000,
              "floor": "2. OG",
              "equipment": [
                "mobile-display",
                "whiteboard",
                "pinboard",
                "moderation-kit"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-4",
              "description": "Kreativraum für Ideenentwicklung, Design-Sprints und Produkt" +
                "arbeit. Bewegliche Möbel erlauben den Wechsel zwischen Präse" +
                "ntation, Kleingruppen und gemeinsamer Ergebnissicherung.",
              "name": "Innovation Lab",
              "capacity": 16,
              "priceMinor": 10000,
              "floor": "2. OG",
              "equipment": [
                "mobile-display",
                "whiteboard",
                "pinboard",
                "moderation-kit"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-5",
              "description": "Kompakter Rückzugsraum für konzentrierte Abstimmungen und Ei" +
                "nzelgespräche. Ein Monitor, eine Kamera und eine einfache Ti" +
                "schanschlusslösung unterstützen hybride Termine.",
              "name": "Focus One",
              "capacity": 4,
              "priceMinor": 3500,
              "floor": "1. OG",
              "equipment": [
                "display-55",
                "usb-camera",
                "usb-c-dock"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-6",
              "description": "Kleiner Besprechungsraum abseits der offenen Arbeitsflächen." +
                " Für Interviews, kurze Projektabsprachen und Videokonferenze" +
                "n in kleiner Runde.",
              "name": "Focus Two",
              "capacity": 4,
              "priceMinor": 3500,
              "floor": "1. OG",
              "equipment": [
                "display-55",
                "usb-camera",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-7",
              "description": "Schulungsraum mit Reihen- und Gruppenbestuhlung, guter Sicht" +
                " auf die Präsentationsfläche und zusätzlichen Stromanschlüss" +
                "en. Für Trainings, Einführungsveranstaltungen und ganztägige" +
                " Seminare.",
              "name": "Training Campus",
              "capacity": 36,
              "priceMinor": 16000,
              "floor": "EG",
              "equipment": [
                "projector",
                "projection-screen",
                "wireless-mic",
                "flipchart"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-8",
              "description": "Besprechungsbereich mit komfortabler Sitzgruppe und einem se" +
                "paraten Arbeitstisch. Geeignet für kleine Kundengespräche, I" +
                "nterviews und Strategieabstimmungen.",
              "name": "Executive Lounge",
              "capacity": 8,
              "priceMinor": 9000,
              "floor": "3. OG",
              "equipment": [
                "display-65",
                "video-system",
                "speakerphone"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-9",
              "description": "Großer Veranstaltungsraum mit Bühne, Präsentationsfläche und" +
                " Mikrofontechnik. Die Reihenbestuhlung unterstützt Townhalls" +
                ", Informationsveranstaltungen und größere Kundenveranstaltun" +
                "gen.",
              "name": "Townhall Auditorium",
              "capacity": 80,
              "priceMinor": 30000,
              "floor": "EG",
              "equipment": [
                "projector",
                "projection-screen",
                "wireless-mic",
                "presenter",
                "hearing-support"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            },
            {
              "id": "northwind-berlin-room-10",
              "description": "Raum für anspruchsvolle hybride Meetings mit mehreren Kamera" +
                "perspektiven, guter Sprachverständlichkeit und regelbarer Be" +
                "leuchtung. Für externe Präsentationen und digitale Workshops" +
                ".",
              "name": "Hybrid Studio",
              "capacity": 10,
              "priceMinor": 12000,
              "floor": "3. OG",
              "equipment": [
                "display-86",
                "video-system",
                "usb-camera",
                "wireless-mic",
                "studio-light"
              ],
              "accessibility": [
                "Stufenlos erreichbar",
                "Aufzug vorhanden"
              ]
            }
          ]
        }
      ],
      "catalogue": {
        "services": [
          "room",
          "catering"
        ],
        "currency": "EUR",
        "equipment": [
          {
            "id": "mobile-display",
            "name": "Mobiles Präsentationsdisplay",
            "description": "Rollbares Display für Präsentationen und Gruppenarbeit.",
            "active": true,
            "order": 1,
            "price": {
              "amountMinor": 2500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-3",
              "northwind-berlin-room-4"
            ]
          },
          {
            "id": "display-86",
            "name": "86-Zoll-Präsentationsdisplay",
            "description": "Großformatige Bildfläche für größere Konferenzräume.",
            "active": true,
            "order": 2,
            "price": {
              "amountMinor": 3500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-1",
              "northwind-berlin-room-10"
            ]
          },
          {
            "id": "display-65",
            "name": "65-Zoll-Präsentationsdisplay",
            "description": "Präsentationsdisplay für mittelgroße Besprechungen.",
            "active": true,
            "order": 3,
            "price": {
              "amountMinor": 2200,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-2",
              "northwind-berlin-room-8"
            ]
          },
          {
            "id": "display-55",
            "name": "55-Zoll-Präsentationsdisplay",
            "description": "Kompaktes Display für kleine Gesprächsrunden.",
            "active": true,
            "order": 4,
            "price": {
              "amountMinor": 1500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-5",
              "northwind-berlin-room-6"
            ]
          },
          {
            "id": "video-system",
            "name": "Hybrides Videokonferenzsystem",
            "description": "Kamera, Mikrofone und Lautsprecher für hybride Meetings.",
            "active": true,
            "order": 5,
            "price": {
              "amountMinor": 4500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-1",
              "northwind-berlin-room-2",
              "northwind-berlin-room-8",
              "northwind-berlin-room-10"
            ]
          },
          {
            "id": "usb-camera",
            "name": "USB-Konferenzkamera",
            "description": "Zusätzliche Kamera für Laptop-basierte Konferenzen.",
            "active": true,
            "order": 6,
            "price": {
              "amountMinor": 1200,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-5",
              "northwind-berlin-room-6",
              "northwind-berlin-room-10"
            ]
          },
          {
            "id": "speakerphone",
            "name": "Konferenzlautsprecher",
            "description": "Tischlautsprecher mit integriertem Mikrofon.",
            "active": true,
            "order": 7,
            "price": {
              "amountMinor": 800,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-2",
              "northwind-berlin-room-6",
              "northwind-berlin-room-8"
            ]
          },
          {
            "id": "wireless-mic",
            "name": "Funkmikrofon-Set",
            "description": "Drahtloses Mikrofon für Präsentationen und Diskussionen.",
            "active": true,
            "order": 8,
            "price": {
              "amountMinor": 1800,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-1",
              "northwind-berlin-room-7",
              "northwind-berlin-room-9",
              "northwind-berlin-room-10"
            ]
          },
          {
            "id": "whiteboard",
            "name": "Mobiles Whiteboard",
            "description": "Beschreibbare Arbeitsfläche inklusive Stiften und Reinigung.",
            "active": true,
            "order": 9,
            "price": {
              "amountMinor": 1000,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-1",
              "northwind-berlin-room-3",
              "northwind-berlin-room-4"
            ]
          },
          {
            "id": "pinboard",
            "name": "Moderations-Pinnwand",
            "description": "Mobile Pinnwand für strukturierte Gruppenarbeit.",
            "active": true,
            "order": 10,
            "price": {
              "amountMinor": 800,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-3",
              "northwind-berlin-room-4"
            ]
          },
          {
            "id": "moderation-kit",
            "name": "Moderationskoffer",
            "description": "Karten, Marker, Klebepunkte und Moderationszubehör.",
            "active": true,
            "order": 11,
            "price": {
              "amountMinor": 1500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-3",
              "northwind-berlin-room-4"
            ]
          },
          {
            "id": "projector",
            "name": "Präsentationsprojektor",
            "description": "Projektor für großflächige Präsentationen.",
            "active": true,
            "order": 12,
            "price": {
              "amountMinor": 3000,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-7",
              "northwind-berlin-room-9"
            ]
          },
          {
            "id": "projection-screen",
            "name": "Projektionsleinwand",
            "description": "Mobile oder fest installierte Präsentationsfläche.",
            "active": true,
            "order": 13,
            "price": {
              "amountMinor": 1000,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-7",
              "northwind-berlin-room-9"
            ]
          },
          {
            "id": "flipchart",
            "name": "Flipchart",
            "description": "Flipchart mit Papier und Stiften.",
            "active": true,
            "order": 14,
            "price": {
              "amountMinor": 700,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-7"
            ]
          },
          {
            "id": "usb-c-dock",
            "name": "USB-C-Anschlussstation",
            "description": "Anschlusslösung für unterstützte Präsentationsgeräte.",
            "active": true,
            "order": 15,
            "price": {
              "amountMinor": 500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-5"
            ]
          },
          {
            "id": "presenter",
            "name": "Kabelloser Presenter",
            "description": "Fernsteuerung für Folienpräsentationen.",
            "active": true,
            "order": 16,
            "price": {
              "amountMinor": 400,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-9"
            ]
          },
          {
            "id": "hearing-support",
            "name": "Mobile Hörunterstützung",
            "description": "Zusätzliche Hörunterstützung nach vorheriger Abstimmung.",
            "active": true,
            "order": 17,
            "price": {
              "amountMinor": 2000,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-9"
            ]
          },
          {
            "id": "studio-light",
            "name": "Studio-Beleuchtungsset",
            "description": "Regelbare Beleuchtung für hybride Präsentationen.",
            "active": true,
            "order": 18,
            "price": {
              "amountMinor": 2000,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [
              "northwind-berlin-room-10"
            ]
          }
        ],
        "cateringPackages": [
          {
            "id": "coffee-break",
            "name": "Kaffeepause",
            "description": "Kaffee, Tee, Wasser und Gebäck für eine kurze Besprechungspa" +
              "use.",
            "active": true,
            "order": 1,
            "price": {
              "amountMinor": 1200,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [],
            "itemIds": [
              "coffee-tea",
              "water-juice",
              "pastry"
            ],
            "variants": [
              {
                "id": "coffee-break-standard",
                "name": "Standard",
                "description": null,
                "active": true,
                "order": 1,
                "price": {
                  "amountMinor": 1200,
                  "currency": "EUR"
                }
              }
            ]
          },
          {
            "id": "business-breakfast",
            "name": "Business-Frühstück",
            "description": "Getränke, Obst und vegetarische Sandwiches zum gemeinsamen S" +
              "tart.",
            "active": true,
            "order": 2,
            "price": {
              "amountMinor": 1800,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [],
            "itemIds": [
              "coffee-tea",
              "water-juice",
              "fruit",
              "sandwich-vegetarian"
            ],
            "variants": [
              {
                "id": "business-breakfast-standard",
                "name": "Standard",
                "description": null,
                "active": true,
                "order": 1,
                "price": {
                  "amountMinor": 1800,
                  "currency": "EUR"
                }
              }
            ]
          },
          {
            "id": "workshop-day",
            "name": "Workshop-Tag",
            "description": "Tagesbegleitung mit Getränken, Lunch und Nachmittagssnack.",
            "active": true,
            "order": 3,
            "price": {
              "amountMinor": 4200,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [],
            "itemIds": [
              "coffee-tea",
              "water-juice",
              "lunch-classic",
              "afternoon-snack"
            ],
            "variants": [
              {
                "id": "workshop-day-standard",
                "name": "Standard",
                "description": null,
                "active": true,
                "order": 1,
                "price": {
                  "amountMinor": 4200,
                  "currency": "EUR"
                }
              }
            ]
          },
          {
            "id": "vegan-day",
            "name": "Veganer Konferenztag",
            "description": "Pflanzliches Tagesangebot mit Obst, Getränken und veganem Lu" +
              "nch.",
            "active": true,
            "order": 4,
            "price": {
              "amountMinor": 3900,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": [],
            "itemIds": [
              "coffee-tea",
              "water-juice",
              "fruit",
              "lunch-vegan"
            ],
            "variants": [
              {
                "id": "vegan-day-standard",
                "name": "Standard",
                "description": null,
                "active": true,
                "order": 1,
                "price": {
                  "amountMinor": 3900,
                  "currency": "EUR"
                }
              }
            ]
          }
        ],
        "cateringItems": [
          {
            "id": "coffee-tea",
            "name": "Kaffee und Tee",
            "description": "Heißgetränke für die Besprechungspause.",
            "active": true,
            "order": 1,
            "price": {
              "amountMinor": 450,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "water-juice",
            "name": "Wasser und Saft",
            "description": "Mineralwasser und Saftauswahl.",
            "active": true,
            "order": 2,
            "price": {
              "amountMinor": 350,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "fruit",
            "name": "Obstauswahl",
            "description": "Portionierte saisonale Obstauswahl.",
            "active": true,
            "order": 3,
            "price": {
              "amountMinor": 450,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "pastry",
            "name": "Gebäckauswahl",
            "description": "Kleine süße Gebäckstücke zur Kaffeepause.",
            "active": true,
            "order": 4,
            "price": {
              "amountMinor": 500,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "sandwich-vegetarian",
            "name": "Vegetarische Sandwiches",
            "description": "Belegte Sandwiches mit vegetarischer Füllung.",
            "active": true,
            "order": 5,
            "price": {
              "amountMinor": 900,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "lunch-vegan",
            "name": "Veganes Lunch-Buffet",
            "description": "Pflanzliche warme und kalte Komponenten.",
            "active": true,
            "order": 6,
            "price": {
              "amountMinor": 2400,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "lunch-classic",
            "name": "Klassisches Lunch-Buffet",
            "description": "Gemischtes Lunch-Angebot einschließlich vegetarischer Auswah" +
              "l.",
            "active": true,
            "order": 7,
            "price": {
              "amountMinor": 2700,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          },
          {
            "id": "afternoon-snack",
            "name": "Nachmittagssnack",
            "description": "Kleine herzhafte und süße Snacks.",
            "active": true,
            "order": 8,
            "price": {
              "amountMinor": 700,
              "currency": "EUR"
            },
            "siteIds": [
              "11000000-0000-4000-8000-000000000001"
            ],
            "roomIds": []
          }
        ]
      }
    },
    "costCenters": [
      {
        "id": "cc-1000",
        "code": "1000",
        "name": "Geschäftsleitung",
        "active": true
      },
      {
        "id": "cc-2100",
        "code": "2100",
        "name": "Vertrieb",
        "active": true
      },
      {
        "id": "cc-3100",
        "code": "3100",
        "name": "Produktentwicklung",
        "active": true
      },
      {
        "id": "cc-4100",
        "code": "4100",
        "name": "Personal",
        "active": true
      },
      {
        "id": "cc-5100",
        "code": "5100",
        "name": "IT",
        "active": true
      },
      {
        "id": "cc-6100",
        "code": "6100",
        "name": "Marketing",
        "active": true
      }
    ],
    "requests": [
      {
        "id": "12000000-0000-4000-8000-000000000001",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-1",
        "status": "Confirmed",
        "startsAt": "2026-06-16T07:00:00.000Z",
        "endsAt": "2026-06-16T09:00:00.000Z",
        "internalParticipants": 16,
        "externalParticipants": 2,
        "title": "Strategieabstimmung",
        "equipmentIds": [
          "display-86",
          "video-system"
        ],
        "cateringPackageId": "coffee-break",
        "costCenterId": "cc-1000",
        "description": "Strategieabstimmung mit vorbereitetem Raum, passender Präsen" +
          "tationstechnik und abgestimmtem Catering. Alle Angaben sind " +
          "synthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000002",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-2",
        "status": "Confirmed",
        "startsAt": "2026-06-17T07:00:00.000Z",
        "endsAt": "2026-06-17T09:00:00.000Z",
        "internalParticipants": 8,
        "externalParticipants": 2,
        "title": "Vertriebsplanung",
        "equipmentIds": [
          "display-65",
          "video-system"
        ],
        "cateringPackageId": "business-breakfast",
        "costCenterId": "cc-2100",
        "description": "Vertriebsplanung mit vorbereitetem Raum, passender Präsentat" +
          "ionstechnik und abgestimmtem Catering. Alle Angaben sind syn" +
          "thetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000003",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-3",
        "status": "Confirmed",
        "startsAt": "2026-06-18T07:00:00.000Z",
        "endsAt": "2026-06-18T09:00:00.000Z",
        "internalParticipants": 14,
        "externalParticipants": 2,
        "title": "Produkt-Workshop",
        "equipmentIds": [
          "mobile-display",
          "whiteboard"
        ],
        "cateringPackageId": "workshop-day",
        "costCenterId": "cc-3100",
        "description": "Produkt-Workshop mit vorbereitetem Raum, passender Präsentat" +
          "ionstechnik und abgestimmtem Catering. Alle Angaben sind syn" +
          "thetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000004",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-4",
        "status": "Confirmed",
        "startsAt": "2026-06-19T07:00:00.000Z",
        "endsAt": "2026-06-19T09:00:00.000Z",
        "internalParticipants": 10,
        "externalParticipants": 2,
        "title": "Design-Sprint",
        "equipmentIds": [
          "mobile-display",
          "whiteboard"
        ],
        "cateringPackageId": "vegan-day",
        "costCenterId": "cc-4100",
        "description": "Design-Sprint mit vorbereitetem Raum, passender Präsentation" +
          "stechnik und abgestimmtem Catering. Alle Angaben sind synthe" +
          "tische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000005",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-5",
        "status": "Confirmed",
        "startsAt": "2026-06-20T07:00:00.000Z",
        "endsAt": "2026-06-20T09:00:00.000Z",
        "internalParticipants": 3,
        "externalParticipants": 0,
        "title": "Projektabstimmung",
        "equipmentIds": [
          "display-55",
          "usb-camera"
        ],
        "cateringPackageId": "coffee-break",
        "costCenterId": "cc-5100",
        "description": "Projektabstimmung mit vorbereitetem Raum, passender Präsenta" +
          "tionstechnik und abgestimmtem Catering. Alle Angaben sind sy" +
          "nthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000006",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-6",
        "status": "Confirmed",
        "startsAt": "2026-06-16T07:00:00.000Z",
        "endsAt": "2026-06-16T09:00:00.000Z",
        "internalParticipants": 4,
        "externalParticipants": 0,
        "title": "Bewerbungsgespräch",
        "equipmentIds": [
          "display-55",
          "usb-camera"
        ],
        "cateringPackageId": "business-breakfast",
        "costCenterId": "cc-6100",
        "description": "Bewerbungsgespräch mit vorbereitetem Raum, passender Präsent" +
          "ationstechnik und abgestimmtem Catering. Alle Angaben sind s" +
          "ynthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000007",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-7",
        "status": "Confirmed",
        "startsAt": "2026-06-17T07:00:00.000Z",
        "endsAt": "2026-06-17T09:00:00.000Z",
        "internalParticipants": 26,
        "externalParticipants": 2,
        "title": "Onboarding-Training",
        "equipmentIds": [
          "projector",
          "projection-screen"
        ],
        "cateringPackageId": "workshop-day",
        "costCenterId": "cc-1000",
        "description": "Onboarding-Training mit vorbereitetem Raum, passender Präsen" +
          "tationstechnik und abgestimmtem Catering. Alle Angaben sind " +
          "synthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000008",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-8",
        "status": "Confirmed",
        "startsAt": "2026-06-18T07:00:00.000Z",
        "endsAt": "2026-06-18T09:00:00.000Z",
        "internalParticipants": 4,
        "externalParticipants": 2,
        "title": "Kundengespräch",
        "equipmentIds": [
          "display-65",
          "video-system"
        ],
        "cateringPackageId": "vegan-day",
        "costCenterId": "cc-2100",
        "description": "Kundengespräch mit vorbereitetem Raum, passender Präsentatio" +
          "nstechnik und abgestimmtem Catering. Alle Angaben sind synth" +
          "etische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000009",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-9",
        "status": "Confirmed",
        "startsAt": "2026-06-19T07:00:00.000Z",
        "endsAt": "2026-06-19T09:00:00.000Z",
        "internalParticipants": 58,
        "externalParticipants": 2,
        "title": "Townhall",
        "equipmentIds": [
          "projector",
          "projection-screen"
        ],
        "cateringPackageId": "coffee-break",
        "costCenterId": "cc-3100",
        "description": "Townhall mit vorbereitetem Raum, passender Präsentationstech" +
          "nik und abgestimmtem Catering. Alle Angaben sind synthetisch" +
          "e Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000010",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-10",
        "status": "Confirmed",
        "startsAt": "2026-06-20T07:00:00.000Z",
        "endsAt": "2026-06-20T09:00:00.000Z",
        "internalParticipants": 6,
        "externalParticipants": 2,
        "title": "Hybrider Kundenworkshop",
        "equipmentIds": [
          "display-86",
          "video-system"
        ],
        "cateringPackageId": "business-breakfast",
        "costCenterId": "cc-4100",
        "description": "Hybrider Kundenworkshop mit vorbereitetem Raum, passender Pr" +
          "äsentationstechnik und abgestimmtem Catering. Alle Angaben s" +
          "ind synthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000011",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-1",
        "status": "Confirmed",
        "startsAt": "2026-06-23T11:00:00.000Z",
        "endsAt": "2026-06-23T13:00:00.000Z",
        "internalParticipants": 16,
        "externalParticipants": 2,
        "title": "Portfolio-Review",
        "equipmentIds": [
          "display-86",
          "video-system"
        ],
        "cateringPackageId": "workshop-day",
        "costCenterId": "cc-5100",
        "description": "Portfolio-Review mit vorbereitetem Raum, passender Präsentat" +
          "ionstechnik und abgestimmtem Catering. Alle Angaben sind syn" +
          "thetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000012",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-2",
        "status": "Confirmed",
        "startsAt": "2026-06-24T11:00:00.000Z",
        "endsAt": "2026-06-24T13:00:00.000Z",
        "internalParticipants": 8,
        "externalParticipants": 2,
        "title": "Angebotsabstimmung",
        "equipmentIds": [
          "display-65",
          "video-system"
        ],
        "cateringPackageId": "vegan-day",
        "costCenterId": "cc-6100",
        "description": "Angebotsabstimmung mit vorbereitetem Raum, passender Präsent" +
          "ationstechnik und abgestimmtem Catering. Alle Angaben sind s" +
          "ynthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000013",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-3",
        "status": "Confirmed",
        "startsAt": "2026-06-25T11:00:00.000Z",
        "endsAt": "2026-06-25T13:00:00.000Z",
        "internalParticipants": 14,
        "externalParticipants": 2,
        "title": "Retrospektive",
        "equipmentIds": [
          "mobile-display",
          "whiteboard"
        ],
        "cateringPackageId": "coffee-break",
        "costCenterId": "cc-1000",
        "description": "Retrospektive mit vorbereitetem Raum, passender Präsentation" +
          "stechnik und abgestimmtem Catering. Alle Angaben sind synthe" +
          "tische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000014",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-4",
        "status": "Confirmed",
        "startsAt": "2026-06-26T11:00:00.000Z",
        "endsAt": "2026-06-26T13:00:00.000Z",
        "internalParticipants": 10,
        "externalParticipants": 2,
        "title": "Innovationsworkshop",
        "equipmentIds": [
          "mobile-display",
          "whiteboard"
        ],
        "cateringPackageId": "business-breakfast",
        "costCenterId": "cc-2100",
        "description": "Innovationsworkshop mit vorbereitetem Raum, passender Präsen" +
          "tationstechnik und abgestimmtem Catering. Alle Angaben sind " +
          "synthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000015",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-5",
        "status": "Confirmed",
        "startsAt": "2026-06-27T11:00:00.000Z",
        "endsAt": "2026-06-27T13:00:00.000Z",
        "internalParticipants": 3,
        "externalParticipants": 0,
        "title": "Teamabstimmung",
        "equipmentIds": [
          "display-55",
          "usb-camera"
        ],
        "cateringPackageId": "workshop-day",
        "costCenterId": "cc-3100",
        "description": "Teamabstimmung mit vorbereitetem Raum, passender Präsentatio" +
          "nstechnik und abgestimmtem Catering. Alle Angaben sind synth" +
          "etische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000016",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-6",
        "status": "Confirmed",
        "startsAt": "2026-06-23T11:00:00.000Z",
        "endsAt": "2026-06-23T13:00:00.000Z",
        "internalParticipants": 4,
        "externalParticipants": 0,
        "title": "Interviewrunde",
        "equipmentIds": [
          "display-55",
          "usb-camera"
        ],
        "cateringPackageId": "vegan-day",
        "costCenterId": "cc-4100",
        "description": "Interviewrunde mit vorbereitetem Raum, passender Präsentatio" +
          "nstechnik und abgestimmtem Catering. Alle Angaben sind synth" +
          "etische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000017",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-7",
        "status": "In Review",
        "startsAt": "2026-06-24T11:00:00.000Z",
        "endsAt": "2026-06-24T13:00:00.000Z",
        "internalParticipants": 26,
        "externalParticipants": 2,
        "title": "Methodentraining",
        "equipmentIds": [
          "projector",
          "projection-screen"
        ],
        "cateringPackageId": "coffee-break",
        "costCenterId": "cc-5100",
        "description": "Methodentraining mit vorbereitetem Raum, passender Präsentat" +
          "ionstechnik und abgestimmtem Catering. Alle Angaben sind syn" +
          "thetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000018",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-8",
        "status": "In Review",
        "startsAt": "2026-06-25T11:00:00.000Z",
        "endsAt": "2026-06-25T13:00:00.000Z",
        "internalParticipants": 4,
        "externalParticipants": 2,
        "title": "Partnergespräch",
        "equipmentIds": [
          "display-65",
          "video-system"
        ],
        "cateringPackageId": "business-breakfast",
        "costCenterId": "cc-6100",
        "description": "Partnergespräch mit vorbereitetem Raum, passender Präsentati" +
          "onstechnik und abgestimmtem Catering. Alle Angaben sind synt" +
          "hetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000019",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-9",
        "status": "In Review",
        "startsAt": "2026-06-26T11:00:00.000Z",
        "endsAt": "2026-06-26T13:00:00.000Z",
        "internalParticipants": 58,
        "externalParticipants": 2,
        "title": "Informationsveranstaltung",
        "equipmentIds": [
          "projector",
          "projection-screen"
        ],
        "cateringPackageId": "workshop-day",
        "costCenterId": "cc-1000",
        "description": "Informationsveranstaltung mit vorbereitetem Raum, passender " +
          "Präsentationstechnik und abgestimmtem Catering. Alle Angaben" +
          " sind synthetische Demodaten."
      },
      {
        "id": "12000000-0000-4000-8000-000000000020",
        "requesterUserId": "13000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-10",
        "status": "In Review",
        "startsAt": "2026-06-27T11:00:00.000Z",
        "endsAt": "2026-06-27T13:00:00.000Z",
        "internalParticipants": 6,
        "externalParticipants": 2,
        "title": "Hybride Produktpräsentation",
        "equipmentIds": [
          "display-86",
          "video-system"
        ],
        "cateringPackageId": "vegan-day",
        "costCenterId": "cc-2100",
        "description": "Hybride Produktpräsentation mit vorbereitetem Raum, passende" +
          "r Präsentationstechnik und abgestimmtem Catering. Alle Angab" +
          "en sind synthetische Demodaten."
      }
    ],
    "catalogueMedia": [
      {
        "id": "52000000-0000-4000-8000-000000000001",
        "assetKey": "northwind-room-01",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-1",
        "sha256": "33f8bc5f45e7e5e5147394f40ae2b19e4bcbe09f49c338fe5fa1b6de7c47" +
          "a80f",
        "byteLength": 12383,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Berlin Forum"
      },
      {
        "id": "52000000-0000-4000-8000-000000000002",
        "assetKey": "northwind-room-02",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-2",
        "sha256": "192ebdaf5d18960b4c138849e9bdbb498bb9911f490ed4fe02f39df1eebb" +
          "c7d7",
        "byteLength": 13953,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Spree Boardroom"
      },
      {
        "id": "52000000-0000-4000-8000-000000000003",
        "assetKey": "northwind-room-03",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-3",
        "sha256": "a11e87c826a48f69a90743abd14cda6111e8e29771f2f3a7384a75b0ec40" +
          "efab",
        "byteLength": 14434,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Workshop Loft"
      },
      {
        "id": "52000000-0000-4000-8000-000000000004",
        "assetKey": "northwind-room-04",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-4",
        "sha256": "fb3656543afe7b05390c2674b8588c1cae3b76aed27e6cf268c54ecb953d" +
          "5392",
        "byteLength": 12768,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Innovation Lab"
      },
      {
        "id": "52000000-0000-4000-8000-000000000005",
        "assetKey": "northwind-room-05",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-5",
        "sha256": "3cff292a157a020f823291475764bace95a6764f2e37b5aab7e28e425678" +
          "7f0e",
        "byteLength": 12097,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Focus One"
      },
      {
        "id": "52000000-0000-4000-8000-000000000006",
        "assetKey": "northwind-room-06",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-6",
        "sha256": "7372b10c12946f5dce2ceff34b910895ede3a95c45e583bed755383321a5" +
          "6029",
        "byteLength": 11167,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Focus Two"
      },
      {
        "id": "52000000-0000-4000-8000-000000000007",
        "assetKey": "northwind-room-07",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-7",
        "sha256": "2301bc2f82291222c2b059ba6d0ee442b8c7b11bc7a335f367b8ff3708f9" +
          "0eab",
        "byteLength": 14868,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Training Campus"
      },
      {
        "id": "52000000-0000-4000-8000-000000000008",
        "assetKey": "northwind-room-08",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-8",
        "sha256": "c56a22ed5e1019fb09d1b101f03c595c69da87e9f79f12d6144095314bc6" +
          "212f",
        "byteLength": 13554,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Executive Lounge"
      },
      {
        "id": "52000000-0000-4000-8000-000000000009",
        "assetKey": "northwind-room-09",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-9",
        "sha256": "cd630e0aaef46cbbc1f5bc4590bb0b75fa13c5bd53727bb2589c821136c9" +
          "6221",
        "byteLength": 16443,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Townhall Auditorium"
      },
      {
        "id": "52000000-0000-4000-8000-000000000010",
        "assetKey": "northwind-room-10",
        "ownerKind": "room_plan",
        "ownerId": "northwind-berlin-room-10",
        "sha256": "6e0ad25489ccfc5cdad5782cb2a11ae98c1547ad426e8f4e2118179dd87c" +
          "df17",
        "byteLength": 12819,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Hybrid Studio"
      },
      {
        "id": "53000000-0000-4000-8000-000000000001",
        "assetKey": "coffee-break",
        "ownerKind": "catering_package",
        "ownerId": "coffee-break",
        "sha256": "866d0253456f42a76cd16c2fe03b9e60ec22679924de520a8fe2a6af355d" +
          "df6a",
        "byteLength": 187128,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Kaffeepause"
      },
      {
        "id": "53000000-0000-4000-8000-000000000002",
        "assetKey": "business-breakfast",
        "ownerKind": "catering_package",
        "ownerId": "business-breakfast",
        "sha256": "8fb3bcf1c8231f42415e482df65c163d22585845acdf0fcc08ae9afa93da" +
          "a2d1",
        "byteLength": 258184,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Business-Frühstück"
      },
      {
        "id": "53000000-0000-4000-8000-000000000003",
        "assetKey": "workshop-day",
        "ownerKind": "catering_package",
        "ownerId": "workshop-day",
        "sha256": "5e80d1b2ae57850dd2fc7ab252c542d23ac4ccd8362a0fae465bfdf75238" +
          "ae73",
        "byteLength": 246504,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Workshop-Tag"
      },
      {
        "id": "53000000-0000-4000-8000-000000000004",
        "assetKey": "vegan-day",
        "ownerKind": "catering_package",
        "ownerId": "vegan-day",
        "sha256": "8f7ce6d7249c419cff20571a6eda8f6ffe7b641090b9322f05c429d0ad33" +
          "78cb",
        "byteLength": 260008,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Veganer Konferenztag"
      },
      {
        "id": "53000000-0000-4000-8000-000000000005",
        "assetKey": "coffee-tea",
        "ownerKind": "catering_item",
        "ownerId": "coffee-tea",
        "sha256": "00a7cdf0e9d018658728d7aef4386ff0e87f9272ec3bc785f908d027c4b4" +
          "a6fa",
        "byteLength": 146026,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Kaffee und Tee"
      },
      {
        "id": "53000000-0000-4000-8000-000000000006",
        "assetKey": "water-juice",
        "ownerKind": "catering_item",
        "ownerId": "water-juice",
        "sha256": "d890d3773fc81d548a4ab7804be83dbaa2dd8c4325de629edd9e14ba6b11" +
          "ee78",
        "byteLength": 187934,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Wasser und Saft"
      },
      {
        "id": "53000000-0000-4000-8000-000000000007",
        "assetKey": "fruit",
        "ownerKind": "catering_item",
        "ownerId": "fruit",
        "sha256": "ca727f10dd85239e54cb0563e41170ff40463f8dfae6f1ca6f5945daf3f9" +
          "461c",
        "byteLength": 236294,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Obstauswahl"
      },
      {
        "id": "53000000-0000-4000-8000-000000000008",
        "assetKey": "pastry",
        "ownerKind": "catering_item",
        "ownerId": "pastry",
        "sha256": "c27848277dbf9c2fc126571da6cc5dcccd51f53d464504f4736a4579827a" +
          "3407",
        "byteLength": 288090,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Gebäckauswahl"
      },
      {
        "id": "53000000-0000-4000-8000-000000000009",
        "assetKey": "sandwich-vegetarian",
        "ownerKind": "catering_item",
        "ownerId": "sandwich-vegetarian",
        "sha256": "7416c0ab54ba74957f2aa07a8f60495a1afc32886450e96a237ac7047c50" +
          "5ee1",
        "byteLength": 274060,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Vegetarische Sandwiches"
      },
      {
        "id": "53000000-0000-4000-8000-000000000010",
        "assetKey": "lunch-vegan",
        "ownerKind": "catering_item",
        "ownerId": "lunch-vegan",
        "sha256": "0acb3ac24d44500b1dc463269ec02ea3649560fe69f698faa41cdf7c850c" +
          "fb05",
        "byteLength": 298930,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Veganes Lunch-Buffet"
      },
      {
        "id": "53000000-0000-4000-8000-000000000011",
        "assetKey": "lunch-classic",
        "ownerKind": "catering_item",
        "ownerId": "lunch-classic",
        "sha256": "5d8e795e397bb2e8f62bb7cd7b330546fc5c97a04d2a78522d26f6a32e26" +
          "5fb7",
        "byteLength": 281512,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Klassisches Lunch-Buffet"
      },
      {
        "id": "53000000-0000-4000-8000-000000000012",
        "assetKey": "afternoon-snack",
        "ownerKind": "catering_item",
        "ownerId": "afternoon-snack",
        "sha256": "5ab9d811f774737a31b522f963efbc7b689b028bade4a6178fe825f29445" +
          "08dc",
        "byteLength": 211610,
        "contentType": "image/webp",
        "altText": "Illustratives Demobild: Nachmittagssnack"
      }
    ],
    "roomMedia": [
      {
        "id": "51000000-0000-4000-8000-000000000001",
        "roomId": "northwind-berlin-room-1",
        "sha256": "0e97d1b75e31955893dc8460a40b49190e9c9b91e3c53fead0fb7993afcd" +
          "e387",
        "byteLength": 225950,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000002",
        "roomId": "northwind-berlin-room-2",
        "sha256": "24c659f53e141243a090be3128e8a45b2a04f166e123f677e2ac5ba3ee56" +
          "fbd0",
        "byteLength": 238496,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000003",
        "roomId": "northwind-berlin-room-3",
        "sha256": "c1c9ade4b2162c3c7a147ea10fa7f92e5cb1279041f5d50b82048cd4fb9c" +
          "b589",
        "byteLength": 230970,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000004",
        "roomId": "northwind-berlin-room-4",
        "sha256": "5830a01f60e1609c085364b9cc7d60be59e35ea512aaba65e970cfa775a6" +
          "7af2",
        "byteLength": 202872,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000005",
        "roomId": "northwind-berlin-room-5",
        "sha256": "85d837bbc8dcbbc04ecf36e044effaad8e4f06008c05c718457ccb544627" +
          "1ea6",
        "byteLength": 192812,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000006",
        "roomId": "northwind-berlin-room-6",
        "sha256": "d2fa0db2d251f1f313a1a4c575388e0df0534fdf74b26500e4c7434b2463" +
          "a4cc",
        "byteLength": 199094,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000007",
        "roomId": "northwind-berlin-room-7",
        "sha256": "6af2d97d846039a27a96750844f0ecb27e83a3c920a84ce0bcb113d74232" +
          "3750",
        "byteLength": 199832,
        "width": 1672,
        "height": 940
      },
      {
        "id": "51000000-0000-4000-8000-000000000008",
        "roomId": "northwind-berlin-room-8",
        "sha256": "fefd5edb31626b4a5772bb46d670e0066778e3dcdebf401dd925be5b2959" +
          "de48",
        "byteLength": 176664,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000009",
        "roomId": "northwind-berlin-room-9",
        "sha256": "c2edd44e096f47205ee94940693013648b359f933ab9ac4806ede28ddd71" +
          "acc1",
        "byteLength": 143546,
        "width": 1672,
        "height": 941
      },
      {
        "id": "51000000-0000-4000-8000-000000000010",
        "roomId": "northwind-berlin-room-10",
        "sha256": "29a82bf0ab79d189f2a1cc576c8f30d868a998d5e01313560cfd8e41db9b" +
          "b8d2",
        "byteLength": 172110,
        "width": 1672,
        "height": 941
      }
    ]
  },
  {
    "id": "20000000-0000-4000-8000-000000000002",
    "displayName": "Contoso Demo",
    "lifecycleStatus": "ready",
    "lifecycleRevision": 1,
    "settings": {
      "organization": {
        "name": "Contoso Demo SAS",
        "countryCode": "FR"
      },
      "locations": [
        {
          "id": "21000000-0000-4000-8000-000000000002",
          "name": "Paris Demo Campus",
          "timeZone": "Europe/Paris",
          "guestInformation": {
            "address": {
              "line1": "Example Campus 1",
              "line2": null,
              "postalCode": "75001",
              "city": "Paris",
              "countryCode": "FR"
            },
            "publicTransport": "Use the public transport stop at the campus entrance.",
            "arrival": "Please arrive ten minutes before the meeting.",
            "parking": "Visitor parking is signposted at the main entrance.",
            "reception": "Register at the main reception.",
            "building": "Conference building",
            "visitorNotes": "Synthetic demonstration information.",
            "accessibility": "Step-free entrance and lift.",
            "wifiPolicy": "credentials_on_arrival",
            "wifiNetworkName": "Demo Guest",
            "contact": {
              "name": "Demo Reception",
              "email": "reception@example.invalid",
              "phone": null
            },
            "routeUrl": null
          },
          "rooms": [
            {
              "id": "contoso-paris-room-1",
              "description": "Kleiner Besprechungsraum mit Präsentationsdisplay.",
              "name": "Paris Atelier",
              "capacity": 16,
              "priceMinor": 9500,
              "floor": null,
              "equipment": [],
              "accessibility": []
            },
            {
              "id": "contoso-paris-room-2",
              "description": null,
              "name": "Paris Studio",
              "capacity": 6,
              "priceMinor": null,
              "floor": null,
              "equipment": [],
              "accessibility": []
            }
          ]
        }
      ],
      "catalogue": {
        "services": [
          "room"
        ],
        "currency": "EUR",
        "equipment": [
          {
            "id": "mobile-display",
            "name": "Contoso mobile display",
            "description": null,
            "active": true,
            "order": 1,
            "price": {
              "amountMinor": 1800,
              "currency": "EUR"
            },
            "siteIds": [
              "21000000-0000-4000-8000-000000000002"
            ],
            "roomIds": [
              "contoso-paris-room-1"
            ]
          },
          {
            "id": "contoso-projector",
            "name": "Contoso projector",
            "description": null,
            "active": true,
            "order": 2,
            "price": {
              "amountMinor": 3200,
              "currency": "EUR"
            },
            "siteIds": [],
            "roomIds": []
          }
        ],
        "cateringPackages": [],
        "cateringItems": []
      }
    },
    "costCenters": [
      {
        "id": "cc-100",
        "code": "100",
        "name": "Allgemein",
        "active": true
      }
    ],
    "requests": [
      {
        "id": "22000000-0000-4000-8000-000000000002",
        "requesterUserId": "23000000-0000-4000-8000-000000000002",
        "roomId": "contoso-paris-room-1",
        "status": "In Review",
        "startsAt": "2026-06-17T08:00:00.000Z",
        "endsAt": "2026-06-17T09:30:00.000Z",
        "internalParticipants": 5,
        "externalParticipants": 0,
        "title": "Teamworkshop prüfen",
        "equipmentIds": [],
        "cateringPackageId": null,
        "costCenterId": null,
        "description": null
      },
      {
        "id": "22000000-0000-4000-8000-000000000003",
        "requesterUserId": "23000000-0000-4000-8000-000000000002",
        "roomId": "contoso-paris-room-1",
        "status": "In Review",
        "startsAt": "2026-06-18T08:00:00.000Z",
        "endsAt": "2026-06-18T09:30:00.000Z",
        "internalParticipants": 5,
        "externalParticipants": 0,
        "title": "Kundentermin prüfen",
        "equipmentIds": [],
        "cateringPackageId": null,
        "costCenterId": null,
        "description": null
      },
      {
        "id": "22000000-0000-4000-8000-000000000004",
        "requesterUserId": "23000000-0000-4000-8000-000000000002",
        "roomId": "contoso-paris-room-1",
        "status": "In Review",
        "startsAt": "2026-06-19T08:00:00.000Z",
        "endsAt": "2026-06-19T09:30:00.000Z",
        "internalParticipants": 5,
        "externalParticipants": 0,
        "title": "Projektbesprechung prüfen",
        "equipmentIds": [],
        "cateringPackageId": null,
        "costCenterId": null,
        "description": null
      }
    ],
    "catalogueMedia": [
      {
        "id": "52000000-0000-4000-8000-000000000011",
        "assetKey": "contoso-paris-room-1",
        "ownerKind": "room_plan",
        "ownerId": "contoso-paris-room-1",
        "sha256": "3e39b46306dae5b39b7e13cdc1b5b742bde3d75da4bc0b216b45f43ff226" +
          "868d",
        "byteLength": 11232,
        "contentType": "image/png",
        "altText": "Illustrativer Raumplan: Paris Atelier"
      }
    ],
    "roomMedia": [
      {
        "id": "51000000-0000-4000-8000-000000000021",
        "roomId": "contoso-paris-room-1",
        "sha256": "2014af4e798fd951b964b3e4ff923d3e014817ea94db167fbe26f06d2c43" +
          "8d5a",
        "byteLength": 188352,
        "width": 1672,
        "height": 941
      }
    ]
  },
  {
    "id": "40000000-0000-4000-8000-000000000004",
    "displayName": "Fabrikam Demo",
    "lifecycleStatus": "onboarding",
    "lifecycleRevision": 1,
    "settings": {
      "organization": {
        "name": null,
        "countryCode": "DE"
      },
      "locations": [],
      "catalogue": {
        "services": [],
        "currency": "EUR",
        "equipment": [],
        "cateringPackages": [],
        "cateringItems": []
      }
    },
    "costCenters": [],
    "requests": [],
    "catalogueMedia": [],
    "roomMedia": []
  }
];

export function cloneSyntheticBusinessTemplateData() { return structuredClone(BUSINESS_TEMPLATES); }
